import { createLogger } from './modules/logger.js';
import { createWasmApi } from './modules/wasmApi.js';
import { createFsSync } from './modules/fsSync.js';
import { createContextMenu } from './modules/contextMenu.js';
import { createFirewireSetup } from './modules/firewireSetup.js';
import { readAudioTags, getAudioProperties, getFiletypeFromName, isAudioFile } from './modules/audio.js';
import { renderTracks, renderPlaylists, formatDuration, updateConnectionStatus, enableUIIfReady } from './modules/uiRender.js';

/**
 * TunesReloaded - module entrypoint
 * Keeps existing UI behavior while making the codebase modular.
 */

let ipodHandle = null;
let isConnected = false;
let allTracks = [];
let allPlaylists = [];
let currentPlaylistIndex = -1; // -1 means "All Tracks"

const { log, toggleLogPanel, escapeHtml } = createLogger();
const wasm = createWasmApi({ log });
const fsSync = createFsSync({ log, wasm, mountpoint: '/iPod' });
const firewireSetup = createFirewireSetup({ log });

// === Database / view refresh ===
async function parseDatabase() {
    log('Parsing iTunesDB...');
    const result = wasm.wasmCallWithError('ipod_parse_db');
    if (result !== 0) return;

    isConnected = true;
    updateConnectionStatus(true);
    enableUIIfReady({ wasmReady: wasm.isReady(), isConnected });

    await refreshCurrentView();
    log('Database loaded successfully', 'success');
}

async function loadTracks() {
    log('Loading tracks...');
    const tracks = wasm.wasmGetJson('ipod_get_all_tracks_json');
    if (tracks) {
        allTracks = tracks;
        renderTracks({ tracks, escapeHtml });
    }
}

async function loadPlaylists() {
    log('Loading playlists...');
    const playlists = wasm.wasmGetJson('ipod_get_all_playlists_json');
    if (playlists) {
        allPlaylists = playlists;
        renderPlaylists({
            playlists,
            currentPlaylistIndex,
            allTracksCount: allTracks.length,
            escapeHtml,
        });
    }
}

async function loadPlaylistTracks(index) {
    if (index < 0 || index >= allPlaylists.length) {
        log(`Invalid playlist index: ${index}`, 'error');
        return;
    }

    const playlistName = allPlaylists[index].name;
    log(`Loading tracks for playlist: "${playlistName}"`, 'info');

    const tracks = wasm.wasmGetJson('ipod_get_playlist_tracks_json', index);
    if (tracks) {
        renderTracks({ tracks, escapeHtml });
    }
}

async function refreshCurrentView() {
    await loadPlaylists();
    if (currentPlaylistIndex === -1) {
        await loadTracks();
    } else if (currentPlaylistIndex >= 0 && currentPlaylistIndex < allPlaylists.length) {
        await loadPlaylistTracks(currentPlaylistIndex);
    } else {
        currentPlaylistIndex = -1;
        await loadTracks();
    }
}

async function refreshTracks() {
    const saved = currentPlaylistIndex;
    await loadPlaylists();
    currentPlaylistIndex = saved;
    await refreshCurrentView();
    log('Refreshed track list', 'info');
}

async function saveDatabase() {
    log('Saving database...');
    const result = wasm.wasmCallWithError('ipod_write_db');
    if (result !== 0) return;
    await fsSync.syncVirtualFSToIpod(ipodHandle);
    await refreshCurrentView();
    log('Database saved successfully', 'success');
}

// === Connect / FS ===
async function selectIpodFolder() {
    try {
        log('Opening folder picker...');
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        ipodHandle = handle;
        log(`Selected folder: ${handle.name}`, 'success');

        const isValid = await fsSync.verifyIpodStructure(handle);
        if (!isValid) {
            log('This folder does not look like an iPod root. Please select the iPod volume root (must contain iPod_Control/iTunes/iTunesDB).', 'error');
            return;
        }

        // Check if FirewireGuid exists (needed for iPod Classic 6G+)
        const hasFirewireGuid = await firewireSetup.checkFirewireGuid(handle);
        if (!hasFirewireGuid) {
            log('FirewireGuid not found - iPod Classic may need setup', 'warning');
            firewireSetup.showModal();
            return; // Wait for user to complete setup
        }

        await continueIpodConnection();
    } catch (e) {
        if (e.name === 'AbortError') {
            log('Folder selection cancelled', 'warning');
        } else {
            log(`Error selecting folder: ${e.message}`, 'error');
        }
    }
}

async function continueIpodConnection() {
    if (!ipodHandle) return;
    await fsSync.setupWasmFilesystem(ipodHandle);
    await parseDatabase();
}

// === FirewireGuid Setup (for iPod Classic 6G+) ===
async function setupFirewireGuid() {
    try {
        await firewireSetup.performSetup(ipodHandle);
        firewireSetup.hideModal();
        log('FirewireGuid setup complete!', 'success');
        await continueIpodConnection();
    } catch (e) {
        if (e.name === 'NotFoundError') {
            log('No device selected', 'warning');
        } else {
            log(`WebUSB error: ${e.message}`, 'error');
        }
    }
}

async function skipFirewireSetup() {
    firewireSetup.hideModal();
    log('Skipping FirewireGuid setup - songs may not appear on iPod', 'warning');
    await continueIpodConnection();
}

// === Playlist modal ===
function showNewPlaylistModal() {
    document.getElementById('newPlaylistModal')?.classList.add('show');
    const input = document.getElementById('playlistName');
    if (input) {
        input.value = '';
        input.focus();
    }
}

function hideNewPlaylistModal() {
    document.getElementById('newPlaylistModal')?.classList.remove('show');
}

function createPlaylist() {
    const name = (document.getElementById('playlistName')?.value || '').trim();
    if (!name) {
        log('Playlist name cannot be empty', 'warning');
        return;
    }

    const result = wasm.wasmCallWithStrings('ipod_create_playlist', [name]);
    if (result < 0) {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to create playlist: ${wasm.wasmGetString(errorPtr)}`, 'error');
        return;
    }

    hideNewPlaylistModal();
    refreshCurrentView();
    log(`Created playlist: ${name}`, 'success');
}

async function deletePlaylist(playlistIndex) {
    if (playlistIndex < 0 || playlistIndex >= allPlaylists.length) {
        log('Invalid playlist index', 'error');
        return;
    }
    const playlist = allPlaylists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot delete master playlist', 'warning');
        return;
    }
    if (!confirm(`Are you sure you want to delete "${playlist.name}"?`)) return;

    const result = wasm.wasmCallWithError('ipod_delete_playlist', playlistIndex);
    if (result !== 0) return;

    if (currentPlaylistIndex === playlistIndex) currentPlaylistIndex = -1;
    await refreshCurrentView();
    log(`Deleted playlist: ${playlist.name}`, 'success');
}

// === Track management ===
async function deleteTrack(trackId) {
    if (!confirm('Are you sure you want to delete this track?')) return;
    const result = wasm.wasmCallWithError('ipod_remove_track', trackId);
    if (result !== 0) return;
    await refreshCurrentView();
    log(`Deleted track ID: ${trackId}`, 'success');
}

async function addTrackToPlaylist(trackId, playlistIndex) {
    if (playlistIndex < 0 || playlistIndex >= allPlaylists.length) {
        log('Invalid playlist index', 'error');
        return;
    }
    const playlist = allPlaylists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot add tracks to master playlist directly', 'warning');
        return;
    }

    const result = wasm.wasmCall('ipod_playlist_add_track', playlistIndex, trackId);
    if (result === 0) {
        await loadPlaylists();
        log(`Added track to playlist: ${playlist.name}`, 'success');
    } else {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to add track: ${wasm.wasmGetString(errorPtr)}`, 'error');
    }
}

async function removeTrackFromPlaylist(trackId) {
    if (currentPlaylistIndex < 0 || currentPlaylistIndex >= allPlaylists.length) {
        log('No playlist selected', 'warning');
        return;
    }
    const playlist = allPlaylists[currentPlaylistIndex];
    if (playlist.is_master) {
        log('Cannot remove tracks from master playlist', 'warning');
        return;
    }
    if (!confirm(`Remove this track from "${playlist.name}"?`)) return;

    const result = wasm.wasmCall('ipod_playlist_remove_track', currentPlaylistIndex, trackId);
    if (result !== 0) {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to remove track: ${wasm.wasmGetString(errorPtr)}`, 'error');
        return;
    }

    await refreshCurrentView();
    log(`Removed track from playlist: ${playlist.name}`, 'success');
}

// === Upload ===
function updateUploadProgress(current, total, filename) {
    const percent = Math.round((current / total) * 100);
    const bar = document.getElementById('uploadProgress');
    const status = document.getElementById('uploadStatus');
    const detail = document.getElementById('uploadDetail');
    if (bar) bar.style.width = `${percent}%`;
    if (status) status.textContent = `Uploading ${current} of ${total}`;
    if (detail) detail.textContent = filename;
}

async function uploadTracks() {
    try {
        const fileHandles = await window.showOpenFilePicker({
            multiple: true,
            types: [{
                description: 'Audio Files',
                accept: { 'audio/*': ['.mp3', '.m4a', '.aac', '.wav', '.aiff'] }
            }]
        });

        if (fileHandles.length === 0) return;
        log(`Selected ${fileHandles.length} files for upload`, 'info');

        document.getElementById('uploadModal')?.classList.add('show');

        for (let i = 0; i < fileHandles.length; i++) {
            const file = await fileHandles[i].getFile();
            updateUploadProgress(i + 1, fileHandles.length, file.name);
            await uploadSingleTrack(file);
        }

        document.getElementById('uploadModal')?.classList.remove('show');
        await refreshCurrentView();
        log(`Upload complete: ${fileHandles.length} tracks`, 'success');
    } catch (e) {
        document.getElementById('uploadModal')?.classList.remove('show');
        if (e.name !== 'AbortError') log(`Upload error: ${e.message}`, 'error');
    }
}

async function uploadSingleTrack(file) {
    const tags = await readAudioTags(file);
    const audioProps = await getAudioProperties(file);
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);

    const filetype = getFiletypeFromName(file.name);

    const trackIndex = wasm.wasmAddTrack({
        title: tags.title || file.name.replace(/\.[^/.]+$/, ''),
        artist: tags.artist,
        album: tags.album,
        genre: tags.genre,
        trackNr: tags.track || 0,
        cdNr: 0,
        year: tags.year || 0,
        durationMs: audioProps.duration,
        bitrateKbps: audioProps.bitrate,
        samplerateHz: audioProps.samplerate,
        sizeBytes: data.length,
        filetype,
    });

    if (trackIndex < 0) {
        const errorPtr = wasm.wasmCall('ipod_get_last_error');
        log(`Failed to add track: ${wasm.wasmGetString(errorPtr)}`, 'error');
        return;
    }

    const destPathPtr = wasm.wasmCallWithStrings('ipod_get_track_dest_path', [file.name]);
    if (!destPathPtr) {
        log('Failed to get destination path', 'error');
        return;
    }

    const destPath = wasm.wasmGetString(destPathPtr);
    wasm.wasmCall('ipod_free_string', destPathPtr);
    if (!destPath) {
        log('Failed to read destination path', 'error');
        return;
    }

    await fsSync.copyFileToVirtualFS(data, destPath);

    // Use ipod_finalize_last_track which uses the stored track pointer directly
    const finalizePathPtr = wasm.wasmAllocString(destPath);
    const result = wasm.wasmCallWithError('ipod_finalize_last_track', finalizePathPtr);
    wasm.wasmFreeString(finalizePathPtr);

    if (result !== 0) {
        const ipodPath = destPath.replace(/^\/iPod\//, '').replace(/\//g, ':');
        wasm.wasmCallWithStrings('ipod_track_set_path', [ipodPath], [trackIndex]);
    }

    if (currentPlaylistIndex >= 0 && currentPlaylistIndex < allPlaylists.length) {
        wasm.wasmCall('ipod_playlist_add_track', currentPlaylistIndex, trackIndex);
    }

    log(`Added: ${tags.title || file.name} (${formatDuration(audioProps.duration)})`, 'success');
}

// === Search / playlist selection ===
function selectPlaylist(index) {
    currentPlaylistIndex = index;
    renderPlaylists({
        playlists: allPlaylists,
        currentPlaylistIndex,
        allTracksCount: allTracks.length,
        escapeHtml,
    });
    if (index === -1) {
        renderTracks({ tracks: allTracks, escapeHtml });
    } else {
        loadPlaylistTracks(index);
    }
}

function filterTracks() {
    const query = (document.getElementById('searchBox')?.value || '').toLowerCase();
    if (!query) {
        if (currentPlaylistIndex === -1) renderTracks({ tracks: allTracks, escapeHtml });
        else loadPlaylistTracks(currentPlaylistIndex);
        return;
    }

    const filtered = allTracks.filter(track =>
        (track.title && track.title.toLowerCase().includes(query)) ||
        (track.artist && track.artist.toLowerCase().includes(query)) ||
        (track.album && track.album.toLowerCase().includes(query))
    );
    renderTracks({ tracks: filtered, escapeHtml });
}

// === Drag & drop ===
function initDragAndDrop() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');

        if (!isConnected) {
            log('Please connect an iPod first', 'warning');
            return;
        }

        const files = Array.from(e.dataTransfer.items)
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter(file => file && isAudioFile(file.name));

        if (files.length === 0) {
            log('No audio files found in drop', 'warning');
            return;
        }

        log(`Dropped ${files.length} files`, 'info');
        document.getElementById('uploadModal')?.classList.add('show');

        for (let i = 0; i < files.length; i++) {
            updateUploadProgress(i + 1, files.length, files[i].name);
            await uploadSingleTrack(files[i]);
        }

        document.getElementById('uploadModal')?.classList.remove('show');
        await refreshCurrentView();
    });
}

// === Context menus ===
const contextMenu = createContextMenu({
    log,
    getAllPlaylists: () => allPlaylists,
    getCurrentPlaylistIndex: () => currentPlaylistIndex,
    actions: {
        deletePlaylist,
        deleteTrack,
        addTrackToPlaylist,
        removeTrackFromPlaylist,
    }
});

// === Expose globals for inline HTML handlers ===
Object.assign(window, {
    toggleLogPanel,
    selectIpodFolder,
    uploadTracks,
    saveDatabase,
    refreshTracks,
    showNewPlaylistModal,
    hideNewPlaylistModal,
    createPlaylist,
    selectPlaylist,
    filterTracks,
    deleteTrack,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    hideContextMenu: contextMenu.hideContextMenu,
    setupFirewireGuid,
    skipFirewireSetup,
});

// === Initialization ===
document.addEventListener('DOMContentLoaded', async () => {
    log('TunesReloaded initialized');

    if (!('showDirectoryPicker' in window)) {
        log('File System Access API not supported. Use Chrome or Edge.', 'error');
        const btn = document.getElementById('connectBtn');
        if (btn) btn.disabled = true;
    }

    initDragAndDrop();
    contextMenu.initContextMenu();
    contextMenu.attachPlaylistContextMenus();
    contextMenu.attachTrackContextMenus();

    const ok = await wasm.initWasm();
    enableUIIfReady({ wasmReady: ok, isConnected });
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isConnected) saveDatabase();
    }
});

