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
    ['uploadBtn', 'saveBtn', 'refreshBtn', 'newPlaylistBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !ready;
    });
}

export function renderTracks({ tracks, escapeHtml }) {
    const tbody = document.getElementById('trackTableBody');
    const table = document.getElementById('trackTable');
    const emptyState = document.getElementById('emptyState');
    if (!tbody || !table || !emptyState) return;

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

    tbody.innerHTML = tracks.map((track, index) => `
        <tr data-id="${track.id}" data-track-id="${track.id}">
            <td>${index + 1}</td>
            <td class="title">${escapeHtml(track.title || 'Unknown')}</td>
            <td>${escapeHtml(track.artist || 'Unknown')}</td>
            <td>${escapeHtml(track.album || 'Unknown')}</td>
            <td>${escapeHtml(track.genre || '')}</td>
            <td class="duration">${formatDuration(track.tracklen)}</td>
            <td>
                <button class="btn btn-secondary" onclick="deleteTrack(${track.id})" style="padding: 5px 10px; font-size: 0.8rem;">
                    Delete
                </button>
            </td>
        </tr>
    `).join('');
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

