export function createTrackOps({
    appState,
    wasm,
    paths,
    log,
    logWasmError,
    refreshCurrentView,
    loadPlaylists,
} = {}) {
    async function deleteTrack(trackId) {
        if (!confirm('Are you sure you want to delete this track?')) return;

        // Grab the file path before removing the track (indexes shift after delete).
        const track = wasm.wasmGetJson('ipod_get_track_json', trackId);
        const ipodPath = track?.ipod_path;
        const relFsPath = ipodPath ? paths.toRelFsPathFromIpodDbPath(ipodPath) : null;

        const result = wasm.wasmCallWithError('ipod_remove_track', trackId);
        if (result !== 0) return;

        // Defer the actual file delete until the next "Sync iPod".
        if (relFsPath) {
            appState.pendingFileDeletes = [...(appState.pendingFileDeletes || []), relFsPath];
            log?.(`Marked for deletion on next sync: ${relFsPath}`, 'info');
        }

        await refreshCurrentView();
        log?.(`Deleted track ID: ${trackId}`, 'success');
    }

    async function addTrackToPlaylist(trackId, playlistIndex) {
        const playlists = appState.playlists;
        if (playlistIndex < 0 || playlistIndex >= playlists.length) {
            log?.('Invalid playlist index', 'error');
            return;
        }
        const playlist = playlists[playlistIndex];
        if (playlist.is_master) {
            log?.('Cannot add tracks to master playlist directly', 'warning');
            return;
        }

        const result = wasm.wasmCall('ipod_playlist_add_track', playlistIndex, trackId);
        if (result === 0) {
            await loadPlaylists();
            log?.(`Added track to playlist: ${playlist.name}`, 'success');
        } else {
            logWasmError?.('Failed to add track');
        }
    }

    async function removeTrackFromPlaylist(trackId) {
        const idx = appState.currentPlaylistIndex;
        const playlists = appState.playlists;
        if (idx < 0 || idx >= playlists.length) {
            log?.('No playlist selected', 'warning');
            return;
        }
        const playlist = playlists[idx];
        if (playlist.is_master) {
            log?.('Cannot remove tracks from master playlist', 'warning');
            return;
        }
        if (!confirm(`Remove this track from "${playlist.name}"?`)) return;

        const result = wasm.wasmCall('ipod_playlist_remove_track', idx, trackId);
        if (result !== 0) {
            logWasmError?.('Failed to remove track');
            return;
        }

        await refreshCurrentView();
        log?.(`Removed track from playlist: ${playlist.name}`, 'success');
    }

    return { deleteTrack, addTrackToPlaylist, removeTrackFromPlaylist };
}

