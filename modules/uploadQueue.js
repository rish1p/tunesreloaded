export function createUploadQueue({
    appState,
    log,
    readAudioMetadata,
    rerenderAllTracksIfVisible,
} = {}) {
    function appendPendingUploads(queued) {
        appState.pendingUploads = [...(appState.pendingUploads || []), ...queued];
        log?.(`Queued ${queued.length} track(s). Click “Sync iPod” to transfer.`, 'success');
        rerenderAllTracksIfVisible?.();
    }

    async function enrichQueuedUploadsWithTags(queued, getFile) {
        // Best-effort metadata read (fast; does not stage audio into WASM FS)
        for (const item of queued) {
            try {
                const file = await getFile(item);
                const { tags, props } = await readAudioMetadata(file);
                item.meta = {
                    title: tags.title,
                    artist: tags.artist,
                    album: tags.album,
                    genre: tags.genre,
                    durationMs: props.duration,
                    bitrateKbps: props.bitrate,
                    samplerateHz: props.samplerate,
                    trackNr: tags.track || 0,
                    year: tags.year || 0,
                };
            } catch (_) {
                // ignore
            }
        }
        // Trigger UI refresh with updated metadata
        appState.pendingUploads = [...(appState.pendingUploads || [])];
        rerenderAllTracksIfVisible?.();
    }

    async function getOrComputeQueuedMeta(item, file) {
        // If the user hits "Sync iPod" before enrichment finishes, compute metadata once here.
        const existing = item?.meta;
        const hasCoreFields =
            typeof existing?.title === 'string' &&
            typeof existing?.artist === 'string' &&
            typeof existing?.album === 'string' &&
            typeof existing?.genre === 'string' &&
            Number.isFinite(existing?.durationMs) &&
            Number.isFinite(existing?.bitrateKbps) &&
            Number.isFinite(existing?.samplerateHz);

        if (hasCoreFields) return existing;

        const { tags, props } = await readAudioMetadata(file);
        const computed = {
            title: tags.title,
            artist: tags.artist,
            album: tags.album,
            genre: tags.genre,
            durationMs: props.duration,
            bitrateKbps: props.bitrate,
            samplerateHz: props.samplerate,
            trackNr: tags.track || 0,
            year: tags.year || 0,
        };

        if (item) item.meta = computed;
        return computed;
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
        rerenderAllTracksIfVisible?.();
        log?.('Removed queued track', 'info');
    }

    return {
        queueFileHandlesForSync,
        queueFilesForSync,
        removeQueuedTrack,
        getOrComputeQueuedMeta,
    };
}

