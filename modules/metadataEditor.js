export function createMetadataEditor({ wasm, log, refreshCurrentView }) {
    let editingTrackIds = [];

    // ── artwork state ────────────────────────────────────────────────────────
    // Holds the pre-decoded RGBA artwork the user picked via the file dialog.
    // Cleared every time the modal opens or the user clicks the × button.
    let pendingArtwork = null;   // { rgba: Uint8Array, width: number, height: number } | null

    const ARTWORK_MAX_SIZE = 320; // iPod Classic max artwork dimension

    // ── helpers ──────────────────────────────────────────────────────────────

    function getSharedField(trackData, field) {
        const values = [...new Set(trackData.map(t => String(t[field] ?? '')))];
        return values.length === 1 ? values[0] : null; // null = multiple values
    }

    function setInputField(inputId, value, batchPlaceholder = 'Multiple values') {
        const el = document.getElementById(inputId);
        if (!el) return;
        if (value !== null) {
            el.value = value;
            el.placeholder = el.dataset.placeholder || '';
        } else {
            el.value = '';
            el.placeholder = batchPlaceholder;
        }
    }

    function getInputVal(id) {
        return document.getElementById(id)?.value.trim() ?? '';
    }

    // ── artwork helpers ──────────────────────────────────────────────────────

    /**
     * Resize an image file (Blob / File) to at most ARTWORK_MAX_SIZE × ARTWORK_MAX_SIZE
     * using an off-screen Canvas.  Returns the raw RGBA Uint8Array plus dimensions.
     */
    function decodeAndResizeImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                let { width, height } = img;

                // Scale down keeping aspect ratio — artwork is always square on iPod
                // but we preserve the original ratio so libgpod can crop/pad as needed.
                const scale = Math.min(1, ARTWORK_MAX_SIZE / Math.max(width, height));
                width  = Math.round(width  * scale);
                height = Math.round(height * scale);

                const canvas = document.createElement('canvas');
                canvas.width  = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const imageData = ctx.getImageData(0, 0, width, height);
                resolve({
                    rgba:   new Uint8Array(imageData.data.buffer),
                    width,
                    height,
                });
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to decode image'));
            };
            img.src = url;
        });
    }

    /** Show a thumbnail preview inside the artwork-preview container. */
    function showArtworkPreview(file) {
        const preview = document.getElementById('artworkPreview');
        if (!preview) return;
        const url = URL.createObjectURL(file);
        preview.innerHTML = `<img src="${url}" alt="Artwork preview">`;
        // Show the clear button
        const clearBtn = document.getElementById('artworkClearBtn');
        if (clearBtn) clearBtn.style.display = 'inline-block';
    }

    /** Reset artwork preview to the placeholder state. */
    function clearArtworkPreview() {
        const preview = document.getElementById('artworkPreview');
        if (preview) {
            preview.innerHTML = '<span class="artwork-placeholder">Click to<br>set artwork</span>';
        }
        const clearBtn = document.getElementById('artworkClearBtn');
        if (clearBtn) clearBtn.style.display = 'none';
    }

    /** Wire up the hidden file input + artwork preview click. */
    function initArtworkInput() {
        const preview = document.getElementById('artworkPreview');
        const fileInput = document.getElementById('artworkFileInput');
        if (!preview || !fileInput) return;

        preview.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                pendingArtwork = await decodeAndResizeImage(file);
                showArtworkPreview(file);
                log?.(`Artwork loaded: ${pendingArtwork.width}×${pendingArtwork.height}`, 'info');
            } catch (e) {
                log?.(`Failed to process artwork: ${e.message}`, 'error');
                pendingArtwork = null;
                clearArtworkPreview();
            }
            // Reset so selecting the same file again triggers change
            fileInput.value = '';
        });

        const clearBtn = document.getElementById('artworkClearBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                clearArtworkSelection();
            });
        }
    }

    function clearArtworkSelection() {
        pendingArtwork = null;
        clearArtworkPreview();
    }

    // ── public API ────────────────────────────────────────────────────────────

    function showEditModal(trackIds) {
        editingTrackIds = (Array.isArray(trackIds) ? trackIds : [trackIds])
            .filter(id => Number.isFinite(id));
        if (editingTrackIds.length === 0) return;

        const trackData = editingTrackIds
            .map(id => wasm.wasmGetJson('ipod_get_track_json', id))
            .filter(Boolean);
        if (trackData.length === 0) return;

        const isBatch = editingTrackIds.length > 1;

        // String fields
        setInputField('editTitle',  isBatch ? null : getSharedField(trackData, 'title'));
        setInputField('editArtist', getSharedField(trackData, 'artist'));
        setInputField('editAlbum',  getSharedField(trackData, 'album'));
        setInputField('editGenre',  getSharedField(trackData, 'genre'));

        // Number fields — treat 0 as "not set" so the input appears empty.
        const trackNrVal = getSharedField(trackData, 'track_nr');
        setInputField('editTrackNr', trackNrVal !== '0' ? trackNrVal : '');

        const yearVal = getSharedField(trackData, 'year');
        setInputField('editYear', yearVal !== '0' ? yearVal : '');

        // Rating select
        const ratingEl = document.getElementById('editRating');
        if (ratingEl) {
            const ratingVal = getSharedField(trackData, 'rating');
            ratingEl.value = ratingVal !== null ? ratingVal : '';
        }

        // Modal title
        const titleEl = document.getElementById('editModalTitle');
        if (titleEl) titleEl.textContent = isBatch ? `Edit ${editingTrackIds.length} Tracks` : 'Edit Track';

        // Reset artwork state for every open
        clearArtworkSelection();

        document.getElementById('editMetadataModal')?.classList.add('show');
        setTimeout(() => document.getElementById('editTitle')?.focus(), 50);
    }

    function hideEditModal() {
        document.getElementById('editMetadataModal')?.classList.remove('show');
        editingTrackIds = [];
        pendingArtwork = null;
    }

    function saveTrackEdits() {
        if (editingTrackIds.length === 0) return;

        const title  = getInputVal('editTitle')  || null;
        const artist = getInputVal('editArtist') || null;
        const album  = getInputVal('editAlbum')  || null;
        const genre  = getInputVal('editGenre')  || null;

        const trackNrStr = getInputVal('editTrackNr');
        const yearStr    = getInputVal('editYear');
        const ratingStr  = getInputVal('editRating');

        const trackNr = trackNrStr !== '' ? parseInt(trackNrStr, 10) : -1;
        const year    = yearStr    !== '' ? parseInt(yearStr,    10) : -1;
        const rating  = ratingStr  !== '' ? parseInt(ratingStr,  10) : -1;

        const hasMetadataChanges = title || artist || album || genre || trackNr >= 0 || year > 0 || rating >= 0;
        const hasArtwork = pendingArtwork !== null;

        if (!hasMetadataChanges && !hasArtwork) {
            log?.('No changes to save', 'warning');
            return;
        }

        let metaSuccess = 0;
        let artSuccess  = 0;

        for (const trackId of editingTrackIds) {
            // ─ metadata ─
            if (hasMetadataChanges) {
                const result = wasm.wasmUpdateTrack(trackId, { title, artist, album, genre, trackNr, year, rating });
                if (result === 0) {
                    metaSuccess++;
                } else {
                    log?.(`Failed to update metadata for track ${trackId}`, 'error');
                }
            }

            // ─ artwork ─
            if (hasArtwork) {
                const { rgba, width, height } = pendingArtwork;
                const result = wasm.wasmSetTrackArtworkRGBA(trackId, rgba, width, height);
                if (result === 0) {
                    artSuccess++;
                } else if (result === -2) {
                    // GdkPixbuf not available — stop trying for remaining tracks
                    log?.('Artwork requires a rebuilt WASM with GdkPixbuf support. See build.sh.', 'error');
                    break;
                } else {
                    log?.(`Failed to set artwork for track ${trackId}`, 'error');
                }
            }
        }

        // ─ summary ─
        const parts = [];
        if (metaSuccess > 0)
            parts.push(`metadata for ${metaSuccess} ${metaSuccess === 1 ? 'track' : 'tracks'}`);
        if (artSuccess > 0)
            parts.push(`artwork for ${artSuccess} ${artSuccess === 1 ? 'track' : 'tracks'}`);

        if (parts.length > 0) {
            log?.(`Updated ${parts.join(' and ')}. Click "Sync iPod" to save to device.`, 'success');
            refreshCurrentView();
        }

        if (metaSuccess === 0 && artSuccess === 0) {
            log?.('All updates failed. Check the console log for details.', 'error');
            return;
        }

        hideEditModal();
    }

    // One-time DOM wiring (called after DOM is ready)
    function init() {
        initArtworkInput();
    }

    return { showEditModal, hideEditModal, saveTrackEdits, clearArtworkSelection, init };
}
