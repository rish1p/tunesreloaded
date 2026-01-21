export function createContextMenu({ log, getAllPlaylists, getCurrentPlaylistIndex, actions }) {
    const state = { type: null, playlistIndex: null, trackId: null };

    function showContextMenu(x, y) {
        const menu = document.getElementById('contextMenu');
        if (!menu) return;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.add('show');
    }

    function hideContextMenu() {
        const menu = document.getElementById('contextMenu');
        if (menu) menu.classList.remove('show');
        state.type = null;
        state.playlistIndex = null;
        state.trackId = null;
        const submenu = document.getElementById('playlistSubmenu');
        if (submenu) submenu.innerHTML = '';
    }

    function buildPlaylistSubmenu(trackId) {
        const submenu = document.getElementById('playlistSubmenu');
        if (!submenu) return;
        submenu.innerHTML = '';

        const playlists = getAllPlaylists?.() || [];
        const currentIdx = getCurrentPlaylistIndex?.() ?? -1;

        const available = playlists
            .map((pl, idx) => ({ pl, idx }))
            .filter(({ pl, idx }) => !pl.is_master && !(currentIdx >= 0 && idx === currentIdx));

        if (available.length === 0) {
            const div = document.createElement('div');
            div.className = 'context-submenu-item';
            div.style.opacity = '0.5';
            div.textContent = 'No other playlists';
            submenu.appendChild(div);
            return;
        }

        for (const { pl, idx } of available) {
            const item = document.createElement('div');
            item.className = 'context-submenu-item';
            item.textContent = pl.name || 'Untitled';
            item.onclick = async () => {
                await actions?.addTrackToPlaylist?.(trackId, idx);
                hideContextMenu();
            };
            submenu.appendChild(item);
        }
    }

    function initContextMenu() {
        const menu = document.getElementById('contextMenu');
        if (!menu) {
            log?.('Context menu element not found', 'error');
            return;
        }

        const deletePlaylistBtn = document.getElementById('contextDeletePlaylist');
        const deleteTrackBtn = document.getElementById('contextDeleteTrack');
        const addToPlaylistBtn = document.getElementById('contextAddToPlaylist');
        const removeFromPlaylistBtn = document.getElementById('contextRemoveFromPlaylist');

        if (!deletePlaylistBtn || !deleteTrackBtn || !addToPlaylistBtn || !removeFromPlaylistBtn) {
            log?.('Context menu buttons not found', 'error');
            return;
        }

        deletePlaylistBtn.addEventListener('click', async () => {
            if (state.type === 'playlist' && state.playlistIndex != null) {
                await actions?.deletePlaylist?.(state.playlistIndex);
                hideContextMenu();
            }
        });

        deleteTrackBtn.addEventListener('click', async () => {
            if (state.type === 'track' && state.trackId != null) {
                await actions?.deleteTrack?.(state.trackId);
                hideContextMenu();
            }
        });

        removeFromPlaylistBtn.addEventListener('click', async () => {
            if (state.type === 'track' && state.trackId != null) {
                await actions?.removeTrackFromPlaylist?.(state.trackId);
                hideContextMenu();
            }
        });

        // Close on outside click (install once)
        if (!globalThis.__tr_contextMenuClickHandler) {
            globalThis.__tr_contextMenuClickHandler = (e) => {
                if (!menu.contains(e.target)) hideContextMenu();
            };
            document.addEventListener('click', globalThis.__tr_contextMenuClickHandler);
        }

        // Close on escape (install once)
        if (!globalThis.__tr_contextMenuKeyHandler) {
            globalThis.__tr_contextMenuKeyHandler = (e) => {
                if (e.key === 'Escape' && menu.classList.contains('show')) hideContextMenu();
            };
            document.addEventListener('keydown', globalThis.__tr_contextMenuKeyHandler);
        }
    }

    function attachPlaylistContextMenus() {
        const playlistList = document.getElementById('playlistList');
        if (!playlistList) return;

        if (playlistList.dataset.contextMenuHandler) return;

        playlistList.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.playlist-item[data-playlist-index]');
            if (!item) return;

            const playlistIndex = parseInt(item.getAttribute('data-playlist-index'));
            const playlists = getAllPlaylists?.() || [];
            const playlist = playlists[playlistIndex];
            if (playlist && playlist.is_master) return;

            e.preventDefault();
            e.stopPropagation();

            const deletePlaylistBtn = document.getElementById('contextDeletePlaylist');
            const deleteTrackBtn = document.getElementById('contextDeleteTrack');
            const addToPlaylistBtn = document.getElementById('contextAddToPlaylist');
            const removeFromPlaylistBtn = document.getElementById('contextRemoveFromPlaylist');
            if (!deletePlaylistBtn || !deleteTrackBtn || !addToPlaylistBtn || !removeFromPlaylistBtn) return;

            state.type = 'playlist';
            state.playlistIndex = playlistIndex;
            state.trackId = null;

            deletePlaylistBtn.style.display = 'block';
            deleteTrackBtn.style.display = 'none';
            addToPlaylistBtn.style.display = 'none';
            removeFromPlaylistBtn.style.display = 'none';

            showContextMenu(e.pageX, e.pageY);
        });

        playlistList.dataset.contextMenuHandler = 'true';
    }

    function attachTrackContextMenus() {
        const trackTable = document.getElementById('trackTableBody');
        if (!trackTable) return;

        if (trackTable.dataset.contextMenuHandler) return;

        trackTable.addEventListener('contextmenu', (e) => {
            const row = e.target.closest('tr[data-track-id]');
            if (!row) return;

            e.preventDefault();
            e.stopPropagation();

            const trackId = parseInt(row.getAttribute('data-track-id'));

            const deletePlaylistBtn = document.getElementById('contextDeletePlaylist');
            const deleteTrackBtn = document.getElementById('contextDeleteTrack');
            const addToPlaylistBtn = document.getElementById('contextAddToPlaylist');
            const removeFromPlaylistBtn = document.getElementById('contextRemoveFromPlaylist');
            if (!deletePlaylistBtn || !deleteTrackBtn || !addToPlaylistBtn || !removeFromPlaylistBtn) return;

            state.type = 'track';
            state.trackId = trackId;
            state.playlistIndex = getCurrentPlaylistIndex?.() ?? -1;

            deletePlaylistBtn.style.display = 'none';
            deleteTrackBtn.style.display = 'block';
            addToPlaylistBtn.style.display = 'block';

            buildPlaylistSubmenu(trackId);

            const playlists = getAllPlaylists?.() || [];
            const currentIdx = getCurrentPlaylistIndex?.() ?? -1;
            const showRemove = currentIdx >= 0 && currentIdx < playlists.length && !playlists[currentIdx].is_master;
            removeFromPlaylistBtn.style.display = showRemove ? 'block' : 'none';

            showContextMenu(e.pageX, e.pageY);
        });

        trackTable.dataset.contextMenuHandler = 'true';
    }

    return {
        initContextMenu,
        attachPlaylistContextMenus,
        attachTrackContextMenus,
        hideContextMenu,
    };
}

