export function formatDuration(ms) {
    if (!ms) return '--:--';
    const seconds = Math.floor(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function updateConnectionStatus(connected) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const btn = document.getElementById('connectBtn');

    if (!dot || !text || !btn) return;

    if (connected) {
        dot.classList.add('connected');
        text.textContent = 'Connected';
        btn.textContent = 'Change iPod';
    } else {
        dot.classList.remove('connected');
        text.textContent = 'Not Connected';
        btn.textContent = 'Select iPod';
    }
}

export function enableUIIfReady({ wasmReady, isConnected }) {
    const ready = Boolean(wasmReady && isConnected);
    ['uploadBtn', 'uploadFolderBtn', 'saveBtn', 'refreshBtn', 'newPlaylistBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !ready;
    });
}

export function renderTracks({ tracks, escapeHtml, selectedTrackIds } = {}) {
    const tbody = document.getElementById('trackTableBody');
    const table = document.getElementById('trackTable');
    const emptyState = document.getElementById('emptyState');
    if (!tbody || !table || !emptyState) return;

    const selectedSet = new Set(Array.isArray(selectedTrackIds) ? selectedTrackIds : []);

    if (!tracks || tracks.length === 0) {
        table.style.display = 'none';
        emptyState.style.display = 'flex';
        emptyState.innerHTML = `
            <h2>No Tracks</h2>
            <p>Upload some music to get started</p>
        `;
        return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';

    tbody.innerHTML = tracks.map((track, index) => {
        const isQueued = Boolean(track.__queued);
        const numericId = Number(track.id);
        const isSelectable = !isQueued && Number.isFinite(numericId) && numericId >= 0;
        const isSelected = isSelectable && selectedSet.has(numericId);
        const title = escapeHtml(track.title || 'Unknown') + (isQueued ? ' *' : '');
        const artist = escapeHtml(track.artist || (isQueued ? 'Queued' : 'Unknown'));
        const album = escapeHtml(track.album || 'Unknown');
        const genre = escapeHtml(track.genre || '');
        const duration = formatDuration(track.tracklen);

        const actionHtml = isQueued
            ? `<button class="btn btn-secondary" onclick="removeQueuedTrack(${track._queueIndex})" style="padding: 6px 10px; font-size: 12px;">
                    Remove
               </button>`
            : `<button class="btn btn-secondary" onclick="deleteTrack(${track.id})" style="padding: 6px 10px; font-size: 12px;">
                    Delete
               </button>`;

        const attrs = isSelectable
            ? `data-track-id="${escapeHtml(String(numericId))}"`
            : `data-queued="true"`;

        return `
            <tr class="${isSelected ? 'selected' : ''}" data-id="${escapeHtml(String(track.id))}" ${attrs}>
                <td>${index + 1}</td>
                <td class="title">${title}</td>
                <td>${artist}</td>
                <td>${album}</td>
                <td>${genre}</td>
                <td class="duration">${duration}</td>
                <td>${actionHtml}</td>
            </tr>
        `;
    }).join('');
}

export function renderPlaylists({ playlists, currentPlaylistIndex, allTracksCount, escapeHtml }) {
    const list = document.getElementById('playlistList');
    if (!list) return;

    let html = `
        <li class="playlist-item ${currentPlaylistIndex === -1 ? 'active' : ''}"
            onclick="selectPlaylist(-1)">
            <span>All Tracks</span>
            <span class="track-count">${allTracksCount}</span>
        </li>
    `;

    html += (playlists || [])
        .map((pl, idx) => {
            if (pl.is_master) return '';
            return `
                <li class="playlist-item ${currentPlaylistIndex === idx ? 'active' : ''}"
                    data-playlist-index="${idx}"
                    onclick="selectPlaylist(${idx})">
                    <span>${escapeHtml(pl.name)}</span>
                    <span class="track-count">${pl.track_count}</span>
                </li>
            `;
        })
        .join('');

    list.innerHTML = html;
}

