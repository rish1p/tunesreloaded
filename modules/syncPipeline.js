export function createSyncPipeline({
    appState,
    wasm,
    fsSync,
    paths,
    log,
    logWasmError,
    modals,
    refreshCurrentView,
    rerenderAllTracksIfVisible,
    getOrComputeQueuedMeta,
    readAudioMetadata,
    transcodeFlacToAlacM4a,
    getFiletypeFromName,
    formatDuration,
} = {}) {
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

    async function uploadSingleTrack(file, precomputedMeta = null, { destName } = {}) {
        if (!file) return false;
        const meta = precomputedMeta || (await getOrComputeQueuedMeta(null, file));
        const audioProps = {
            duration: meta.durationMs,
            bitrate: meta.bitrateKbps,
            samplerate: meta.samplerateHz,
        };

        const effectiveName = String(destName || file.name || 'track');
        const filetype = getFiletypeFromName(effectiveName);

        const trackIndex = wasm.wasmAddTrack({
            title: meta.title || file.name.replace(/\.[^/.]+$/, ''),
            artist: meta.artist,
            album: meta.album,
            genre: meta.genre,
            trackNr: meta.trackNr || 0,
            cdNr: 0,
            year: meta.year || 0,
            durationMs: audioProps.duration,
            bitrateKbps: audioProps.bitrate,
            samplerateHz: audioProps.samplerate,
            sizeBytes: file.size,
            filetype,
        });

        if (trackIndex < 0) {
            logWasmError?.('Failed to add track');
            return false;
        }

        const destPathPtr = wasm.wasmCallWithStrings('ipod_get_track_dest_path', [effectiveName]);
        if (!destPathPtr) {
            log?.('Failed to get destination path', 'error');
            return false;
        }

        const destPath = wasm.wasmGetString(destPathPtr);
        wasm.wasmCall('ipod_free_string', destPathPtr);
        if (!destPath) {
            log?.('Failed to read destination path', 'error');
            return false;
        }

        const relFsPath = paths.toRelFsPathFromVfs(destPath);

        // Reserve this path in MEMFS to avoid collisions when generating multiple tracks.
        try { fsSync.reserveVirtualPath(destPath); } catch (_) {}

        // Upload audio directly to the real iPod filesystem (no MEMFS audio staging)
        try {
            await fsSync.writeFileToIpodRelativePath(appState.ipodHandle, relFsPath, file);
        } catch (e) {
            log?.(`Failed to write file to iPod: ${e?.message || e}`, 'error');
            wasm.wasmCallWithError('ipod_remove_track', trackIndex);
            return false;
        }

        // Finalize track metadata WITHOUT requiring the file to exist in MEMFS.
        const finalizePathPtr = wasm.wasmAllocString(destPath);
        const result = wasm.wasmCallWithError('ipod_finalize_last_track_no_stat', finalizePathPtr, file.size);
        wasm.wasmFreeString(finalizePathPtr);

        if (result !== 0) {
            const ipodPath = paths.toIpodDbPathFromRel(relFsPath) || '';
            const setPathRes = wasm.wasmCallWithStrings('ipod_track_set_path', [ipodPath], [trackIndex]);
            if (setPathRes !== 0) {
                wasm.wasmCallWithError('ipod_remove_track', trackIndex);
                return false;
            }
        }

        const idx = appState.currentPlaylistIndex;
        if (idx >= 0 && idx < appState.playlists.length) {
            wasm.wasmCall('ipod_playlist_add_track', idx, trackIndex);
        }

        log?.(`Added: ${meta.title || file.name} (${formatDuration(audioProps.duration)})`, 'success');
        return true;
    }

    async function saveDatabase() {
        if (!appState.isConnected) {
            log?.('Please connect an iPod first', 'warning');
            return;
        }

        modals.showUpload();
        setUploadModalState({
            title: 'Uploading',
            status: 'Preparing...',
            detail: '',
            percent: 0,
            showOk: false,
        });

        // 1) Process queued uploads
        const queue = appState.pendingUploads || [];
        const toStage = queue.filter((q) => q.status !== 'staged');
        if (toStage.length > 0) {
            log?.(`Staging ${toStage.length} queued track(s)...`, 'info');
            setUploadModalState({ status: `Uploading... (${toStage.length} track${toStage.length !== 1 ? 's' : ''})` });

            for (let i = 0; i < toStage.length; i++) {
                const item = toStage[i];
                const file = item.kind === 'handle' ? await item.handle.getFile() : item.file;
                updateUploadProgress(i + 1, toStage.length, file?.name || item.name || 'Unknown');

                const meta = await getOrComputeQueuedMeta(item, file);
                const lowerName = String(file?.name || '').toLowerCase();

                if (lowerName.endsWith('.flac')) {
                    try {
                        setUploadModalState({
                            title: 'Uploading...',
                            status: `Converting FLAC... ${i + 1} of ${toStage.length}`,
                            detail: file.name,
                            percent: Math.round(((i + 1) / toStage.length) * 100),
                            showOk: false,
                        });

                        const m4aFile = await transcodeFlacToAlacM4a(file, {
                            onProgress: ({ progress }) => {
                                const base = (i / toStage.length) * 100;
                                const span = (1 / toStage.length) * 100;
                                const p = Math.round(base + span * Math.max(0, Math.min(1, progress || 0)));
                                setUploadModalState({
                                    title: 'Uploading...',
                                    status: `Converting FLAC... ${i + 1} of ${toStage.length}`,
                                    detail: file.name,
                                    percent: p,
                                    showOk: false,
                                });
                            },
                        });

                        const outMeta = await readAudioMetadata(m4aFile);
                        const combinedMeta = {
                            title: meta.title || outMeta.tags.title,
                            artist: meta.artist || outMeta.tags.artist,
                            album: meta.album || outMeta.tags.album,
                            genre: meta.genre || outMeta.tags.genre,
                            trackNr: meta.trackNr || outMeta.tags.track || 0,
                            year: meta.year || outMeta.tags.year || 0,
                            durationMs: outMeta.props.duration,
                            bitrateKbps: outMeta.props.bitrate,
                            samplerateHz: outMeta.props.samplerate,
                        };

                        const ok = await uploadSingleTrack(m4aFile, combinedMeta, { destName: m4aFile.name });
                        if (ok) item.status = 'staged';
                        continue;
                    } catch (e) {
                        log?.(`FLAC convert failed: ${e?.message || e}`, 'error');
                        continue;
                    }
                }

                const ok = await uploadSingleTrack(file, meta);
                if (ok) item.status = 'staged';
            }

            appState.pendingUploads = [...queue];
            rerenderAllTracksIfVisible?.();
        }

        // 2) Write iTunesDB
        log?.('Syncing iPod database...', 'info');
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

        // 3) Copy iTunesDB (+ optional iTunesSD) to iPod, then apply deletions
        try {
            setUploadModalState({ status: 'Uploading to iPod...', detail: '', percent: 0 });
            const res = await fsSync.syncDbToIpod(appState.ipodHandle, {
                onProgress: ({ percent, detail }) => {
                    setUploadModalState({
                        title: 'Syncing to iPod...',
                        status: 'Syncing to iPod...',
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

            const pendingDeletes = appState.pendingFileDeletes || [];
            if (pendingDeletes.length > 0) {
                for (const relFsPath of pendingDeletes) {
                    try {
                        await fsSync.deleteFileFromIpodRelativePath(appState.ipodHandle, relFsPath);
                        log?.(`Deleted file: ${relFsPath}`, 'info');
                    } catch (e) {
                        log?.(`Could not delete file: ${relFsPath} (${e?.message || e})`, 'warning');
                    }
                }
            }
        } catch (e) {
            log?.(`Sync failed: ${e?.message || e}`, 'error');
            setUploadModalState({
                title: 'Upload failed',
                status: 'Uploading to iPod failed.',
                detail: 'Please check the console log for details.',
                showOk: true,
                okLabel: 'OK',
            });
            return;
        }

        appState.pendingUploads = [];
        appState.pendingFileDeletes = [];

        await refreshCurrentView();
        log?.('Sync complete', 'success');

        setUploadModalState({
            title: 'Done syncing!',
            status: 'Done syncing! Safe to disconnect.',
            detail: '',
            percent: 100,
            showOk: true,
            okLabel: 'OK',
        });
    }

    return {
        saveDatabase,
        dismissUploadModal,
        setUploadModalState,
    };
}

