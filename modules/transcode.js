// FLAC -> ALAC (M4A) transcoding via ffmpeg.wasm (Vite + npm).
//
// Notes:
// - This is CPU + memory heavy; run only during Sync.
// - We load ffmpeg.wasm lazily on first use.
// - ffmpeg core is served from /public/ffmpeg (same-origin) to avoid worker import issues.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ffmpegSingleton = null;
let ffmpegLoading = null;
let lastLogHandler = null;
let lastProgressHandler = null;

async function getFfmpeg() {
    if (ffmpegSingleton?.loaded) return ffmpegSingleton;
    if (ffmpegLoading) return ffmpegLoading;

    const ffmpeg = new FFmpeg();

    ffmpegLoading = (async () => {
        // Vite note from ffmpeg.wasm docs: use the ESM build of @ffmpeg/core.
        // We serve those files from /public/ffmpeg (same origin).
        await ffmpeg.load({
            // toBlobURL is used to bypass worker import restrictions.
            coreURL: await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript'),
            wasmURL: await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
            // Multithread core requires a dedicated worker script.
            workerURL: await toBlobURL('/ffmpeg/ffmpeg-core.worker.js', 'text/javascript'),
        });
        ffmpegSingleton = ffmpeg;
        return ffmpegSingleton;
    })();

    return ffmpegLoading;
}

function replaceExtension(name, newExtWithDot) {
    const base = String(name || 'track').replace(/\.[^/.]+$/, '');
    return `${base}${newExtWithDot}`;
}

export async function transcodeFlacToAlacM4a(file, { onProgress, onLog } = {}) {
    const ffmpeg = await getFfmpeg();

    // Capture logs so failures are debuggable (rc=1 is otherwise opaque).
    const logLines = [];

    // Replace previous handlers to avoid accumulating callbacks across runs.
    try {
        if (lastLogHandler) ffmpeg.off('log', lastLogHandler);
        if (lastProgressHandler) ffmpeg.off('progress', lastProgressHandler);
    } catch (_) {
        // ignore
    }

    lastLogHandler = ({ type, message }) => {
        if (typeof message === 'string' && message) {
            logLines.push(`[${type}] ${message}`);
            if (logLines.length > 200) logLines.shift();
        }
        if (typeof onLog === 'function') {
            try { onLog({ type, message }); } catch (_) {}
        }
    };
    ffmpeg.on('log', lastLogHandler);

    lastProgressHandler = ({ progress, time }) => {
        if (typeof onProgress === 'function') {
            try { onProgress({ progress, time }); } catch (_) {}
        }
    };
    ffmpeg.on('progress', lastProgressHandler);

    const inputName = 'input.flac';
    const outputName = 'output.m4a';

    try {
        await ffmpeg.writeFile(inputName, await fetchFile(file));

        // Equivalent to: ffmpeg -i track.flac -acodec alac track.m4a
        //
        // IMPORTANT: Many FLACs contain embedded cover art as an "attached picture" stream.
        // If we don't constrain stream mapping, ffmpeg may try to encode that picture as video
        // (e.g. h264) into the output container, which fails for iPod/MP4 audio-only output.
        //
        // Force audio-only output:
        // -map 0:a:0 : pick first audio stream only
        // -vn/-sn/-dn: disable video/subtitle/data
        // -c:a alac   : encode ALAC
        // -threads 0  : let ffmpeg auto-select thread count (works best with core-mt)
        // -map_metadata 0 : preserve tags where possible
        const rc = await ffmpeg.exec([
            '-i', inputName,
            '-map', '0:a:0',
            '-vn', '-sn', '-dn',
            '-map_metadata', '0',
            '-c:a', 'alac',
            '-threads', '0',
            outputName
        ]);
        if (rc !== 0) {
            const tail = logLines.slice(-40).join('\n');
            throw new Error(`ffmpeg exited with code ${rc}\n\nffmpeg log tail:\n${tail}`);
        }

        const data = await ffmpeg.readFile(outputName); // Uint8Array
        const outFile = new File([data], replaceExtension(file?.name || 'track.flac', '.m4a'), { type: 'audio/mp4' });
        return outFile;
    } finally {
        // Best-effort cleanup to reduce memory in the ffmpeg FS.
        try { await ffmpeg.deleteFile(inputName); } catch (_) {}
        try { await ffmpeg.deleteFile(outputName); } catch (_) {}
    }
}

