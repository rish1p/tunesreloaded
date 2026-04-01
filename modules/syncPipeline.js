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
    firewireSetup,
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

    const DURATION_TOLERANCE_MS = 2000;

    function buildDuplicateIndex() {
        const index = new Map();
        for (const t of (appState.tracks || [])) {
            const key = `${(t.title || '').toLowerCase()}|${(t.artist || '').toLowerCase()}`;
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(t.tracklen || 0);
        }
        return index;
    }

    function isDuplicate(dupIndex, title, artist, durationMs) {
        const key = `${(title || '').toLowerCase()}|${(artist || '').toLowerCase()}`;
        const durations = dupIndex.get(key);
        if (!durations) return false;
        return durations.some(d => Math.abs(d - (durationMs || 0)) <= DURATION_TOLERANCE_MS);
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

            const dupIndex = buildDuplicateIndex();
            let skippedCount = 0;

            // Keep iPod writes sequential, but allow up to 2 FLAC transcodes to run concurrently
            // in the background (via the transcode pool).
            let completed = 0;
            const total = toStage.length;

            let uploadChain = Promise.resolve();
            const enqueueUpload = (fn) => {
                const next = uploadChain.then(fn, fn);
                uploadChain = next.catch(() => {});
                return next;
            };

            const flacTasks = [];

            // Kick off FLAC transcodes early so they can overlap with MP3 uploads.
            // Duplicate check runs on the FLAC's own metadata BEFORE transcoding
            // to avoid wasting CPU on a convert that would be discarded.
            for (const item of toStage) {
                const file = item.kind === 'handle' ? await item.handle.getFile() : item.file;
                const lowerName = String(file?.name || '').toLowerCase();
                if (!lowerName.endsWith('.flac')) continue;

                const meta = await getOrComputeQueuedMeta(item, file);

                if (isDuplicate(dupIndex, meta.title, meta.artist, meta.durationMs)) {
                    log?.(`Skipped (already on iPod): ${meta.title} – ${meta.artist}`, 'info');
                    item.status = 'staged';
                    skippedCount++;
                    completed++;
                    updateUploadProgress(completed, total, file?.name || item.name || 'Unknown');
                    continue;
                }

                // Register in dupIndex now (before the async task) to prevent
                // concurrent FLAC tasks for the same song from both passing the check.
                const preKey = `${(meta.title || '').toLowerCase()}|${(meta.artist || '').toLowerCase()}`;
                if (!dupIndex.has(preKey)) dupIndex.set(preKey, []);
                dupIndex.get(preKey).push(meta.durationMs || 0);

                const task = (async () => {
                    try {
                        setUploadModalState({
                            title: 'Uploading...',
                            status: 'Converting FLACs (up to 2 at a time)...',
                            detail: file.name,
                            percent: Math.round((completed / total) * 100),
                            showOk: false,
                        });

                        const m4aFile = await transcodeFlacToAlacM4a(file);

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

                        await enqueueUpload(async () => {
                            updateUploadProgress(completed + 1, total, m4aFile.name);
                            const ok = await uploadSingleTrack(m4aFile, combinedMeta, { destName: m4aFile.name });
                            if (ok) item.status = 'staged';
                            completed += 1;
                            updateUploadProgress(completed, total, m4aFile.name);
                        });
                    } catch (e) {
                        log?.(`FLAC convert failed: ${e?.message || e}`, 'error');
                    }
                })();

                flacTasks.push(task);
            }

            // Process non-FLAC uploads sequentially (while FLAC transcodes run in background).
            for (const item of toStage) {
                const file = item.kind === 'handle' ? await item.handle.getFile() : item.file;
                const lowerName = String(file?.name || '').toLowerCase();
                if (lowerName.endsWith('.flac')) continue; // handled by background tasks

                const meta = await getOrComputeQueuedMeta(item, file);

                if (isDuplicate(dupIndex, meta.title, meta.artist, meta.durationMs)) {
                    log?.(`Skipped (already on iPod): ${meta.title} – ${meta.artist}`, 'info');
                    item.status = 'staged';
                    skippedCount++;
                    completed++;
                    updateUploadProgress(completed, total, file?.name || item.name || 'Unknown');
                    continue;
                }

                await enqueueUpload(async () => {
                    updateUploadProgress(completed + 1, total, file?.name || item.name || 'Unknown');
                    const ok = await uploadSingleTrack(file, meta);
                    if (ok) {
                        item.status = 'staged';
                        const key = `${(meta.title || '').toLowerCase()}|${(meta.artist || '').toLowerCase()}`;
                        if (!dupIndex.has(key)) dupIndex.set(key, []);
                        dupIndex.get(key).push(meta.durationMs || 0);
                    }
                    completed += 1;
                    updateUploadProgress(completed, total, file?.name || item.name || 'Unknown');
                });
            }

            await Promise.allSettled(flacTasks);
            await uploadChain;

            if (skippedCount > 0) {
                log?.(`Skipped ${skippedCount} duplicate track${skippedCount !== 1 ? 's' : ''} already on iPod`, 'info');
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

        // 2b) Re-sign iTunesCDB + Locations.itdb.cbk with the standalone hashAB WASM
        //     Only Nano 6th/7th gen use hashAB signing.
        if (firewireSetup?.needsHashAB?.()) {
            const fwGuid = firewireSetup.getFirewireGuidHex();
            if (fwGuid) {
                try {
                    await fsSync.reSignDatabaseFiles(fwGuid);
                } catch (e) {
                    log?.(`hashAB re-sign failed: ${e?.message || e}`, 'warning');
                }
            }
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

