import { createLogger } from './modules/logger.js';
import { createWasmApi } from './modules/wasmApi.js';
import { createFsSync } from './modules/fsSync.js';
import { createContextMenu } from './modules/contextMenu.js';
import { createFirewireSetup } from './modules/firewireSetup.js';
import { createModalManager } from './modules/modalManager.js';
import { createAppState } from './modules/state.js';
import { readAudioTags, getAudioProperties, getFiletypeFromName, isAudioFile } from './modules/audio.js';
import { renderTracks, renderPlaylists, formatDuration, updateConnectionStatus, enableUIIfReady } from './modules/uiRender.js';

/**
 * TunesReloaded - module entrypoint
 * Keeps existing UI behavior while making the codebase modular.
 */

// Centralized state
const appState = createAppState();

// Module instances
const { log, toggleLogPanel, escapeHtml } = createLogger();
const wasm = createWasmApi({ log });
const fsSync = createFsSync({ log, wasm, mountpoint: '/iPod' });
const firewireSetup = createFirewireSetup({ log });
const modals = createModalManager();

function getLastWasmErrorMessage() {
    try {
        const ptr = wasm.wasmCall('ipod_get_last_error');
        return ptr ? wasm.wasmGetString(ptr) : 'Unknown error';
    } catch (_) {
        return 'Unknown error';
    }
}

function logWasmError(prefix) {
    log(`${prefix}: ${getLastWasmErrorMessage()}`, 'error');
}

// === Database / view refresh ===
async function parseDatabase() {
    log('Parsing iTunesDB...');
    const result = wasm.wasmCallWithError('ipod_parse_db');
    if (result !== 0) return;

    appState.isConnected = true;
    updateConnectionStatus(true);
    enableUIIfReady({ wasmReady: appState.wasmReady, isConnected: appState.isConnected });

    await refreshCurrentView();
    log('Database loaded successfully', 'success');
}

async function loadTracks() {
    log('Loading tracks...');
    const tracks = wasm.wasmGetJson('ipod_get_all_tracks_json');
    if (tracks) {
        appState.tracks = tracks;
        renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml });

        // Ensure the sidebar "All Tracks" count reflects the latest track list,
        // since refreshCurrentView() loads playlists before tracks.
        renderSidebarPlaylists();
    }
}

function getAllTracksWithQueued() {
    const queued = (appState.pendingUploads || []).map((item, idx) => ({
        id: `queued-${idx}`,
        __queued: true,
        _queueIndex: idx,
        title: item.meta?.title || item.name || 'Queued track',
        artist: item.meta?.artist || 'Queued',
        album: item.meta?.album || '',
        genre: item.meta?.genre || '',
        tracklen: null,
    }));
    return [...(appState.tracks || []), ...queued];
}

function getAllTracksCount() {
    return (appState.tracks?.length || 0) + (appState.pendingUploads?.length || 0);
}

function renderSidebarPlaylists() {
    renderPlaylists({
        playlists: appState.playlists,
        currentPlaylistIndex: appState.currentPlaylistIndex,
        allTracksCount: getAllTracksCount(),
        escapeHtml,
    });
}

function rerenderAllTracksIfVisible() {
    if (appState.currentPlaylistIndex !== -1) return;
    renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml });
    renderSidebarPlaylists();
}

async function loadPlaylists() {
    log('Loading playlists...');
    const playlists = wasm.wasmGetJson('ipod_get_all_playlists_json');
    if (playlists) {
        appState.playlists = playlists;
        renderSidebarPlaylists();
    }
}

async function loadPlaylistTracks(index) {
    if (index < 0 || index >= appState.playlists.length) {
        log(`Invalid playlist index: ${index}`, 'error');
        return;
    }

    const playlistName = appState.playlists[index].name;
    log(`Loading tracks for playlist: "${playlistName}"`, 'info');

    const tracks = wasm.wasmGetJson('ipod_get_playlist_tracks_json', index);
    if (tracks) {
        renderTracks({ tracks, escapeHtml });
    }
}

async function refreshCurrentView() {
    await loadPlaylists();
    const idx = appState.currentPlaylistIndex;
    if (idx === -1) {
        await loadTracks();
    } else if (idx >= 0 && idx < appState.playlists.length) {
        await loadPlaylistTracks(idx);
    } else {
        appState.currentPlaylistIndex = -1;
        await loadTracks();
    }
}

async function refreshTracks() {
    const saved = appState.currentPlaylistIndex;
    await loadPlaylists();
    appState.currentPlaylistIndex = saved;
    await refreshCurrentView();
    log('Refreshed track list', 'info');
}

function setUploadModalState({ title, status, detail, percent, showOk, okLabel } = {}) {
    const titleEl = document.getElementById('uploadTitle');
    const statusEl = document.getElementById('uploadStatus');
    const detailEl = document.getElementById('uploadDetail');
    const barEl = document.getElementById('uploadProgress');
    const actionsEl = document.getElementById('uploadActions');
    const okBtn = document.getElementById('uploadOkBtn');

    if (titleEl && typeof title === 'string') titleEl.textContent = title;
    if (statusEl && typeof status === 'string') statusEl.textContent = status;
    if (detailEl && typeof detail === 'string') detailEl.textContent = detail;
    if (barEl && Number.isFinite(percent)) barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;

    if (actionsEl) actionsEl.style.display = showOk ? 'flex' : 'none';
    if (okBtn && typeof okLabel === 'string') okBtn.textContent = okLabel;
}

function dismissUploadModal() {
    // Reset modal back to default state
    setUploadModalState({
        title: 'Uploading',
        status: 'Preparing...',
        detail: '',
        percent: 0,
        showOk: false,
        okLabel: 'OK',
    });
    modals.hideUpload();
}

async function saveDatabase() {
    if (!appState.isConnected) {
        log('Please connect an iPod first', 'warning');
        return;
    }

    // Always show the modal for the full sync (staging + iPod upload)
    modals.showUpload();
    setUploadModalState({
        title: 'Uploading',
        status: 'Preparing...',
        detail: '',
        percent: 0,
        showOk: false,
    });

    // 1) Process queued uploads (read bytes -> write into WASM FS + add tracks)
    const queue = appState.pendingUploads || [];
    const toStage = queue.filter((q) => q.status !== 'staged');
    if (toStage.length > 0) {
        log(`Staging ${toStage.length} queued track(s)...`, 'info');
        setUploadModalState({ status: `Uploading... (${toStage.length} track${toStage.length !== 1 ? 's' : ''})` });

        for (let i = 0; i < toStage.length; i++) {
            const item = toStage[i];
            const file = item.kind === 'handle' ? await item.handle.getFile() : item.file;
            updateUploadProgress(i + 1, toStage.length, file?.name || item.name || 'Unknown');
            const ok = await uploadSingleTrack(file);
            if (ok) item.status = 'staged';
        }

        // Keep pending uploads until the FULL sync finishes successfully
        appState.pendingUploads = [...queue];
        rerenderAllTracksIfVisible();
    }

    // 2) Write iTunesDB (hash/checksum generation)
    log('Syncing iPod database...', 'info');
    setUploadModalState({ status: 'Preparing database...', detail: '' });
    const result = wasm.wasmCallWithError('ipod_write_db');
    if (result !== 0) {
        setUploadModalState({
            title: 'Upload failed',
            status: 'Failed to prepare database.',
            detail: 'Please check the console log for details.',
            showOk: true,
            okLabel: 'OK',
        });
        return;
    }

    // 3) Copy iTunesDB + music files from WASM FS -> real iPod filesystem
    try {
        setUploadModalState({ status: 'Uploading to iPod...', detail: '', percent: 0 });
        const res = await fsSync.syncVirtualFSToIpod(appState.ipodHandle, {
            onProgress: ({ percent, detail }) => {
                setUploadModalState({
                    title: 'Uploading to iPod...',
                    status: 'Uploading to iPod...',
                    detail: detail || '',
                    percent,
                    showOk: false,
                });
            }
        });

        if (!res?.ok) {
            setUploadModalState({
                title: 'Upload finished with errors',
                status: 'Some files could not be uploaded.',
                detail: 'Please check the console log for details.',
                percent: 100,
                showOk: true,
                okLabel: 'OK',
            });
            return;
        }
    } catch (e) {
        log(`Sync failed: ${e?.message || e}`, 'error');
        setUploadModalState({
            title: 'Upload failed',
            status: 'Uploading to iPod failed.',
            detail: 'Please check the console log for details.',
            showOk: true,
            okLabel: 'OK',
        });
        return;
    }

    // Clear queue only after successful iPod sync so the '*' goes away
    appState.pendingUploads = [];

    // 4) Refresh UI
    await refreshCurrentView();
    log('Sync complete', 'success');

    setUploadModalState({
        title: 'Done uploading!',
        status: 'Done uploading! Safe to disconnect.',
        detail: '',
        percent: 100,
        showOk: true,
        okLabel: 'OK',
    });
}

// === Connect / FS ===
async function selectIpodFolder() {
    try {
        log('Opening folder picker...');
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        appState.ipodHandle = handle;
        log(`Selected folder: ${handle.name}`, 'success');

        const isValid = await fsSync.verifyIpodStructure(handle);
        if (!isValid) {
            log('This folder does not look like an iPod root.', 'error');
            modals.showIpodNotDetected();
            return;
        }

        // Check if FirewireGuid exists (needed for iPod Classic 6G+)
        const hasFirewireGuid = await firewireSetup.checkFirewireGuid(handle);
        if (!hasFirewireGuid) {
            log('FirewireGuid not found - iPod Classic may need setup', 'warning');
            modals.showFirewireSetup();
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
    if (!appState.ipodHandle) return;
    await fsSync.setupWasmFilesystem(appState.ipodHandle);
    await parseDatabase();
}

// === FirewireGuid Setup (for iPod Classic 6G+) ===
async function setupFirewireGuid() {
    try {
        await firewireSetup.performSetup(appState.ipodHandle);
        modals.hideFirewireSetup();
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
    modals.hideFirewireSetup();
    log('Skipping FirewireGuid setup - songs may not appear on iPod', 'warning');
    await continueIpodConnection();
}

// === Welcome Overlay (first visit only) ===
const WELCOME_SEEN_KEY = 'tunesreloaded_welcome_seen';
let isBrowserSupported = true;

function dismissWelcome() {
    modals.hideWelcome();
    localStorage.setItem(WELCOME_SEEN_KEY, 'true');
    
    // Show browser compatibility warning if not supported
    if (!isBrowserSupported) {
        modals.showBrowserCompat();
    }
}

function hideBrowserCompatModal() {
    modals.hideBrowserCompat();
}

function hideIpodNotDetectedModal() {
    modals.hideIpodNotDetected();
}

// === Playlist modal ===
function showNewPlaylistModal() {
    modals.showNewPlaylist();
    const input = document.getElementById('playlistName');
    if (input) {
        input.value = '';
        input.focus();
    }
}

function hideNewPlaylistModal() {
    modals.hideNewPlaylist();
}

function createPlaylist() {
    const name = (document.getElementById('playlistName')?.value || '').trim();
    if (!name) {
        log('Playlist name cannot be empty', 'warning');
        return;
    }

    const result = wasm.wasmCallWithStrings('ipod_create_playlist', [name]);
    if (result < 0) {
        logWasmError('Failed to create playlist');
        return;
    }

    hideNewPlaylistModal();
    refreshCurrentView();
    log(`Created playlist: ${name}`, 'success');
}

async function deletePlaylist(playlistIndex) {
    const playlists = appState.playlists;
    if (playlistIndex < 0 || playlistIndex >= playlists.length) {
        log('Invalid playlist index', 'error');
        return;
    }
    const playlist = playlists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot delete master playlist', 'warning');
        return;
    }
    if (!confirm(`Are you sure you want to delete "${playlist.name}"?`)) return;

    const result = wasm.wasmCallWithError('ipod_delete_playlist', playlistIndex);
    if (result !== 0) return;

    if (appState.currentPlaylistIndex === playlistIndex) {
        appState.currentPlaylistIndex = -1;
    }
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
    const playlists = appState.playlists;
    if (playlistIndex < 0 || playlistIndex >= playlists.length) {
        log('Invalid playlist index', 'error');
        return;
    }
    const playlist = playlists[playlistIndex];
    if (playlist.is_master) {
        log('Cannot add tracks to master playlist directly', 'warning');
        return;
    }

    const result = wasm.wasmCall('ipod_playlist_add_track', playlistIndex, trackId);
    if (result === 0) {
        await loadPlaylists();
        log(`Added track to playlist: ${playlist.name}`, 'success');
    } else {
        logWasmError('Failed to add track');
    }
}

async function removeTrackFromPlaylist(trackId) {
    const idx = appState.currentPlaylistIndex;
    const playlists = appState.playlists;
    if (idx < 0 || idx >= playlists.length) {
        log('No playlist selected', 'warning');
        return;
    }
    const playlist = playlists[idx];
    if (playlist.is_master) {
        log('Cannot remove tracks from master playlist', 'warning');
        return;
    }
    if (!confirm(`Remove this track from "${playlist.name}"?`)) return;

    const result = wasm.wasmCall('ipod_playlist_remove_track', idx, trackId);
    if (result !== 0) {
        logWasmError('Failed to remove track');
        return;
    }

    await refreshCurrentView();
    log(`Removed track from playlist: ${playlist.name}`, 'success');
}

// === Upload ===
function updateUploadProgress(current, total, filename) {
    const percent = Math.round((current / total) * 100);
    setUploadModalState({
        title: 'Uploading...',
        status: `Uploading... ${current} of ${total}`,
        detail: filename,
        percent,
        showOk: false,
    });
}

function appendPendingUploads(queued) {
    appState.pendingUploads = [...(appState.pendingUploads || []), ...queued];
    log(`Queued ${queued.length} track(s). Click “Sync iPod” to transfer.`, 'success');
    rerenderAllTracksIfVisible();
}

async function enrichQueuedUploadsWithTags(queued, getFile) {
    // Best-effort metadata read (fast; does not stage audio into WASM FS)
    for (const item of queued) {
        try {
            const file = await getFile(item);
            const tags = await readAudioTags(file);
            item.meta = { title: tags.title, artist: tags.artist, album: tags.album, genre: tags.genre };
        } catch (_) {
            // ignore
        }
    }
    // Trigger UI refresh with updated metadata
    appState.pendingUploads = [...(appState.pendingUploads || [])];
    rerenderAllTracksIfVisible();
}

function queueUploads({ kind, items, getFileForTags }) {
    const queued = (items || []).map((value) => ({
        kind,
        handle: kind === 'handle' ? value : undefined,
        file: kind === 'file' ? value : undefined,
        name: value?.name || 'Unknown',
        status: 'queued',
        meta: null,
    }));

    appendPendingUploads(queued);

    if (getFileForTags) {
        void enrichQueuedUploadsWithTags(queued, getFileForTags);
    }
}

function queueFileHandlesForSync(fileHandles) {
    queueUploads({
        kind: 'handle',
        items: fileHandles,
        getFileForTags: (item) => item.handle.getFile(),
    });
}

function queueFilesForSync(files) {
    queueUploads({
        kind: 'file',
        items: files,
        getFileForTags: (item) => item.file,
    });
}

function removeQueuedTrack(queueIndex) {
    const q = [...(appState.pendingUploads || [])];
    if (queueIndex < 0 || queueIndex >= q.length) return;
    q.splice(queueIndex, 1);
    appState.pendingUploads = q;
    rerenderAllTracksIfVisible();
    log('Removed queued track', 'info');
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
        queueFileHandlesForSync(fileHandles);
    } catch (e) {
        if (e.name !== 'AbortError') log(`Upload error: ${e.message}`, 'error');
    }
}

async function uploadSingleTrack(file) {
    if (!file) return false;
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
        logWasmError('Failed to add track');
        return false;
    }

    const destPathPtr = wasm.wasmCallWithStrings('ipod_get_track_dest_path', [file.name]);
    if (!destPathPtr) {
        log('Failed to get destination path', 'error');
        return false;
    }

    const destPath = wasm.wasmGetString(destPathPtr);
    wasm.wasmCall('ipod_free_string', destPathPtr);
    if (!destPath) {
        log('Failed to read destination path', 'error');
        return false;
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

    const idx = appState.currentPlaylistIndex;
    if (idx >= 0 && idx < appState.playlists.length) {
        wasm.wasmCall('ipod_playlist_add_track', idx, trackIndex);
    }

    log(`Added: ${tags.title || file.name} (${formatDuration(audioProps.duration)})`, 'success');
    return true;
}

// === Search / playlist selection ===
function selectPlaylist(index) {
    appState.currentPlaylistIndex = index;
    renderSidebarPlaylists();
    if (index === -1) {
        renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml });
    } else {
        loadPlaylistTracks(index);
    }
}

function filterTracks() {
    const query = (document.getElementById('searchBox')?.value || '').toLowerCase();
    const idx = appState.currentPlaylistIndex;
    if (!query) {
        if (idx === -1) renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml });
        else loadPlaylistTracks(idx);
        return;
    }

    const base = idx === -1 ? getAllTracksWithQueued() : (appState.tracks || []);
    const filtered = base.filter(track =>
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

        if (!appState.isConnected) {
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

        queueFilesForSync(files);
    });
}

// === Context menus ===
const contextMenu = createContextMenu({
    log,
    getAllPlaylists: () => appState.playlists,
    getCurrentPlaylistIndex: () => appState.currentPlaylistIndex,
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
    dismissWelcome,
    hideBrowserCompatModal,
    hideIpodNotDetectedModal,
    removeQueuedTrack,
    dismissUploadModal,
});

// === Initialization ===
document.addEventListener('DOMContentLoaded', async () => {
    log('TunesReloaded initialized');

    // Check browser compatibility first
    if (!('showDirectoryPicker' in window)) {
        isBrowserSupported = false;
        log('File System Access API not supported. Use Chrome or Edge.', 'error');
        const btn = document.getElementById('connectBtn');
        if (btn) btn.disabled = true;
    }

    // Show welcome overlay on first visit, or show browser compat warning if unsupported
    const isFirstVisit = !localStorage.getItem(WELCOME_SEEN_KEY);
    if (isFirstVisit) {
        modals.showWelcome();
    } else if (!isBrowserSupported) {
        // Returning user on unsupported browser - show compat modal directly
        modals.showBrowserCompat();
    }

    initDragAndDrop();
    contextMenu.initContextMenu();
    contextMenu.attachPlaylistContextMenus();
    contextMenu.attachTrackContextMenus();

    const ok = await wasm.initWasm();
    appState.wasmReady = ok;
    enableUIIfReady({ wasmReady: ok, isConnected: appState.isConnected });
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (appState.isConnected) saveDatabase();
    }
});

