import { createLogger } from './modules/logger.js';
import { createWasmApi } from './modules/wasmApi.js';
import { createFsSync } from './modules/fsSync.js';
import { createPaths } from './modules/paths.js';
import { createContextMenu } from './modules/contextMenu.js';
import { createFirewireSetup } from './modules/firewireSetup.js';
import { createModalManager } from './modules/modalManager.js';
import { createAppState } from './modules/state.js';
import { readAudioMetadata, getFiletypeFromName, isAudioFile } from './modules/audio.js';
import { renderTracks, renderPlaylists, formatDuration, updateConnectionStatus, enableUIIfReady } from './modules/uiRender.js';
import { createIpodConnectionMonitor } from './modules/ipodConnectionMonitor.js';
import { createUploadQueue } from './modules/uploadQueue.js';
import { createTrackOps } from './modules/trackOps.js';
import { createSyncPipeline } from './modules/syncPipeline.js';
import { createTranscodePool } from './modules/transcode.js';
import { createTrackSelection } from './modules/trackSelection.js';

/**
 * TunesReloaded - module entrypoint
 * Keeps existing UI behavior while making the codebase modular.
 */

// Centralized state
const appState = createAppState();

// Module instances
const { log, escapeHtml, logEntries } = createLogger();
const wasm = createWasmApi({ log });
const fsSync = createFsSync({ log, wasm, mountpoint: '/iPod' });
const paths = createPaths({ wasm, mountpoint: '/iPod' });
const firewireSetup = createFirewireSetup({ log });
const modals = createModalManager();

const ipodMonitor = createIpodConnectionMonitor({
    appState,
    wasm,
    log,
    updateConnectionStatus,
    enableUIIfReady,
    renderTracks,
    renderSidebarPlaylists: () => renderSidebarPlaylists(),
    escapeHtml,
});

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
    ipodMonitor.start();

    await refreshCurrentView();
    log('Database loaded successfully', 'success');
}

async function loadTracks() {
    log('Loading tracks...');
    const tracks = wasm.wasmGetJson('ipod_get_all_tracks_json');
    if (tracks) {
        appState.tracks = tracks;
        renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml, selectedTrackIds: appState.selectedTrackIds });
        trackSelection?.applySelectionToDom?.();

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
        tracklen: Number.isFinite(item.meta?.durationMs) ? item.meta.durationMs : null,
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
    renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml, selectedTrackIds: appState.selectedTrackIds });
    trackSelection?.applySelectionToDom?.();
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
        renderTracks({ tracks, escapeHtml, selectedTrackIds: appState.selectedTrackIds });
        trackSelection.applySelectionToDom();
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

const uploadQueue = createUploadQueue({
    appState,
    log,
    readAudioMetadata,
    rerenderAllTracksIfVisible,
});

const transcodePool = createTranscodePool({ concurrency: 2 });

const trackOps = createTrackOps({
    appState,
    wasm,
    paths,
    log,
    logWasmError,
    refreshCurrentView,
    loadPlaylists,
});

const trackSelection = createTrackSelection({ appState, log });

const syncPipeline = createSyncPipeline({
    appState,
    wasm,
    fsSync,
    paths,
    log,
    logWasmError,
    modals,
    refreshCurrentView,
    rerenderAllTracksIfVisible,
    getOrComputeQueuedMeta: uploadQueue.getOrComputeQueuedMeta,
    readAudioMetadata,
    transcodeFlacToAlacM4a: transcodePool.transcodeFlacToAlacM4a,
    getFiletypeFromName,
    formatDuration,
});

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
const deleteTrack = trackOps.deleteTrack;
const addTrackToPlaylist = trackOps.addTrackToPlaylist;
const removeTrackFromPlaylist = trackOps.removeTrackFromPlaylist;

async function uploadTracks() {
    try {
        const fileHandles = await window.showOpenFilePicker({
            multiple: true,
            types: [{
                description: 'Audio Files',
                accept: { 'audio/*': ['.mp3', '.m4a', '.aac', '.wav', '.aiff', '.flac'] }
            }]
        });

        if (fileHandles.length === 0) return;
        uploadQueue.queueFileHandlesForSync(fileHandles);
    } catch (e) {
        if (e.name !== 'AbortError') log(`Upload error: ${e.message}`, 'error');
    }
}

async function collectAudioFilesFromDirectory(dirHandle, collected = [], onProgress = null) {
    for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
            if (isAudioFile(entry.name)) {
                const file = await entry.getFile();
                collected.push(file);
                onProgress?.(collected.length);
            }
        } else if (entry.kind === 'directory') {
            await collectAudioFilesFromDirectory(entry, collected, onProgress);
        }
    }
    return collected;
}

async function uploadFolder() {
    const dropZone = document.getElementById('dropZone');
    const dropZoneText = dropZone?.querySelector('p');
    const saveBtn = document.getElementById('saveBtn');
    const originalDropText = dropZoneText?.textContent || '';

    try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });

        if (saveBtn) saveBtn.disabled = true;
        if (dropZoneText) dropZoneText.textContent = 'Scanning folder... Found 0 files';

        const fileHandles = await collectAudioFilesFromDirectory(dirHandle, [], (count) => {
            if (dropZoneText) dropZoneText.textContent = `Scanning folder... Found ${count} files`;
        });

        if (dropZoneText) dropZoneText.textContent = originalDropText;
        if (saveBtn && appState.isConnected && appState.wasmReady) saveBtn.disabled = false;

        if (fileHandles.length === 0) {
            log('No audio files found in the selected folder', 'warning');
            return;
        }

        log(`Found ${fileHandles.length} audio file(s)`, 'success');
        uploadQueue.queueFilesForSync(fileHandles);
    } catch (e) {
        if (dropZoneText) dropZoneText.textContent = originalDropText;
        if (saveBtn && appState.isConnected && appState.wasmReady) saveBtn.disabled = false;

        if (e.name === 'AbortError') {
            log('Folder selection cancelled', 'warning');
        } else {
            log(`Folder upload error: ${e.message}`, 'error');
        }
    }
}

// === Search / playlist selection ===
function selectPlaylist(index) {
    trackSelection.clearSelection();
    appState.currentPlaylistIndex = index;
    renderSidebarPlaylists();
    if (index === -1) {
        renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml, selectedTrackIds: appState.selectedTrackIds });
        trackSelection.applySelectionToDom();
    } else {
        loadPlaylistTracks(index);
    }
}

function filterTracks() {
    const query = (document.getElementById('searchBox')?.value || '').toLowerCase();
    const idx = appState.currentPlaylistIndex;
    if (!query) {
        if (idx === -1) {
            renderTracks({ tracks: getAllTracksWithQueued(), escapeHtml, selectedTrackIds: appState.selectedTrackIds });
            trackSelection.applySelectionToDom();
        }
        else loadPlaylistTracks(idx);
        return;
    }

    const base = idx === -1 ? getAllTracksWithQueued() : (appState.tracks || []);
    const filtered = base.filter(track =>
        (track.title && track.title.toLowerCase().includes(query)) ||
        (track.artist && track.artist.toLowerCase().includes(query)) ||
        (track.album && track.album.toLowerCase().includes(query))
    );
    renderTracks({ tracks: filtered, escapeHtml, selectedTrackIds: appState.selectedTrackIds });
    trackSelection.applySelectionToDom();
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

        uploadQueue.queueFilesForSync(files);
    });
}

// === Context menus ===
const contextMenu = createContextMenu({
    log,
    getAllPlaylists: () => appState.playlists,
    getCurrentPlaylistIndex: () => appState.currentPlaylistIndex,
    getSelectedTrackIds: () => appState.selectedTrackIds,
    ensureTrackSelected: (trackId) => trackSelection.ensureTrackSelected(trackId),
    actions: {
        deletePlaylist,
        deleteTrack: trackOps.deleteTrack,
        deleteTracks: trackOps.deleteTracks,
        addTrackToPlaylist: trackOps.addTrackToPlaylist,
        addTracksToPlaylist: trackOps.addTracksToPlaylist,
        removeTrackFromPlaylist: trackOps.removeTrackFromPlaylist,
        removeTracksFromPlaylist: trackOps.removeTracksFromPlaylist,
    }
});

// === Expose globals for inline HTML handlers ===
Object.assign(window, {
    selectIpodFolder,
    uploadTracks,
    uploadFolder,
    saveDatabase: syncPipeline.saveDatabase,
    refreshTracks,
    showNewPlaylistModal,
    hideNewPlaylistModal,
    createPlaylist,
    selectPlaylist,
    filterTracks,
    deleteTrack: trackOps.deleteTrack,
    addTrackToPlaylist: trackOps.addTrackToPlaylist,
    removeTrackFromPlaylist: trackOps.removeTrackFromPlaylist,
    hideContextMenu: contextMenu.hideContextMenu,
    setupFirewireGuid,
    skipFirewireSetup,
    dismissWelcome,
    hideBrowserCompatModal,
    hideIpodNotDetectedModal,
    removeQueuedTrack: uploadQueue.removeQueuedTrack,
    dismissUploadModal: syncPipeline.dismissUploadModal,
    showBugReportModal,
    hideBugReportModal,
    confirmBugReport,
    showConsoleModal,
    hideConsoleModal,
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
    trackSelection.attach();

    const ok = await wasm.initWasm();
    appState.wasmReady = ok;
    enableUIIfReady({ wasmReady: ok, isConnected: appState.isConnected });
});

document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + A: select all visible tracks in table
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        const tag = String(e.target?.tagName || '').toLowerCase();
        const isTypingContext =
            tag === 'input' ||
            tag === 'textarea' ||
            tag === 'select' ||
            e.target?.isContentEditable;
        if (!isTypingContext) {
            e.preventDefault();
            trackSelection.selectAllVisible();
        }
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (appState.isConnected) syncPipeline.saveDatabase();
    }
});

// === Footer actions ===
function showBugReportModal() {
    modals.show('bugReportModal');
}

function hideBugReportModal() {
    modals.hide('bugReportModal');
}

function confirmBugReport() {
    // Open GitHub issues in a new tab; user can paste logs/steps.
    try {
        window.open('https://github.com/rish1p/tunesreloaded/issues/new', '_blank', 'noopener,noreferrer');
    } catch (_) {
        // ignore
    }
    hideBugReportModal();
}

function showConsoleModal() {
    const el = document.getElementById('consoleLogContent');
    if (el) {
        const entries = Array.isArray(logEntries) ? logEntries.slice(-500) : [];
        el.innerHTML = entries.map((e) => {
            const type = escapeHtml(e.type || 'info');
            const ts = escapeHtml(e.timestamp || '');
            const msg = escapeHtml(e.message || '');
            return `<div class="console-line ${type}"><span class="console-ts">[${ts}]</span>${msg}</div>`;
        }).join('') || `<div class="console-line info">No logs yet.</div>`;
        // Scroll to bottom
        el.scrollTop = el.scrollHeight;
    }
    modals.show('consoleModal');
}

function hideConsoleModal() {
    modals.hide('consoleModal');
}
