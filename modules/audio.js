/**
 * Audio helpers (tags + duration) that work in the browser.
 */

// Browser ESM import (no bundler). We intentionally avoid decoding audio.
import { parseBlob } from 'https://esm.sh/music-metadata@11.11.0?bundle';

export function getFiletypeFromName(filename) {
    const lower = String(filename || '').toLowerCase();
    if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'AAC audio file';
    if (lower.endsWith('.wav')) return 'WAV audio file';
    if (lower.endsWith('.aiff') || lower.endsWith('.aif')) return 'AIFF audio file';
    return 'MPEG audio file';
}

export function isAudioFile(filename) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    return ['mp3', 'm4a', 'aac', 'wav', 'aiff'].includes(ext);
}

function fallbackTagsFromFilename(file) {
    const title = file.name.replace(/\.[^/.]+$/, '');
    const match = title.match(/^(.+?)\s*-\s*(.+)$/);
    return {
        title: match ? match[2].trim() : title,
        artist: match ? match[1].trim() : 'Unknown Artist',
        album: 'Unknown Album',
        genre: '',
        track: 0,
        year: 0,
    };
}

async function getDurationViaHtmlAudioMetadata(file) {
    // This does not decode PCM; it just asks the browser for container metadata.
    // Some MP3s can still report Infinity/NaN; caller must validate.
    return await new Promise((resolve) => {
        const audio = new Audio();
        audio.preload = 'metadata';

        const cleanup = () => {
            try { if (audio.src) URL.revokeObjectURL(audio.src); } catch (_) {}
            audio.removeAttribute('src');
            try { audio.load(); } catch (_) {}
        };

        audio.onloadedmetadata = () => {
            const d = audio.duration;
            cleanup();
            resolve(Number.isFinite(d) ? d : null);
        };

        audio.onerror = () => {
            cleanup();
            resolve(null);
        };

        audio.src = URL.createObjectURL(file);
    });
}

export async function readAudioMetadata(file) {
    // IMPORTANT: Never return NaN/Infinity here.
    // Emscripten coerces NaN/Infinity to 0 for int args, producing 0:00 durations on-device.
    const DEFAULT_PROPS = { duration: 180000, bitrate: 192, samplerate: 44100 }; // 3:00 fallback

    try {
        // duration=false avoids full-file scans unless the parser can infer duration from headers.
        const metadata = await parseBlob(file, { skipCovers: true, skipPostHeaders: true, duration: false });

        const c = metadata?.common || {};
        const fmt = metadata?.format || {};

        const trackNo = Number.isFinite(c.track?.no) ? c.track.no : (Number.isFinite(c.track) ? c.track : 0);
        const year = Number.isFinite(c.year) ? c.year : 0;

        const tags = {
            title: c.title || file.name.replace(/\.[^/.]+$/, ''),
            artist: c.artist || 'Unknown Artist',
            album: c.album || 'Unknown Album',
            genre: (Array.isArray(c.genre) ? c.genre[0] : c.genre) || '',
            track: Number.isFinite(trackNo) ? trackNo : 0,
            year,
        };

        // Prefer music-metadata duration when available
        let durationSec = Number.isFinite(fmt.duration) && fmt.duration > 0 ? fmt.duration : null;
        if (!durationSec) {
            // Cheap fallback: HTML metadata (still avoids full decode)
            durationSec = await getDurationViaHtmlAudioMetadata(file);
        }

        const duration = Number.isFinite(durationSec) && durationSec > 0
            ? Math.max(1, Math.floor(durationSec * 1000))
            : DEFAULT_PROPS.duration;

        // fmt.bitrate is bits/second; convert to kbps (this is the "real" bitrate from parser).
        const bitrateKbpsFromFmt = Number.isFinite(fmt.bitrate) ? Math.round(fmt.bitrate / 1000) : null;

        // If parser doesn't provide bitrate, fall back to average bitrate using duration.
        const avgKbps = Number.isFinite(durationSec) && durationSec > 0
            ? Math.floor((file.size * 8) / durationSec / 1000)
            : null;

        const bitrate = (Number.isFinite(bitrateKbpsFromFmt) && bitrateKbpsFromFmt > 0)
            ? bitrateKbpsFromFmt
            : (Number.isFinite(avgKbps) && avgKbps > 0 ? avgKbps : DEFAULT_PROPS.bitrate);

        const samplerate = Number.isFinite(fmt.sampleRate) && fmt.sampleRate > 0 ? fmt.sampleRate : DEFAULT_PROPS.samplerate;

        return { tags, props: { duration, bitrate, samplerate } };
    } catch (_) {
        // Fallback: filename tags + (optional) HTML duration + average bitrate
        const tags = fallbackTagsFromFilename(file);
        const durationSec = await getDurationViaHtmlAudioMetadata(file);
        const duration = Number.isFinite(durationSec) && durationSec > 0
            ? Math.max(1, Math.floor(durationSec * 1000))
            : DEFAULT_PROPS.duration;
        const avgKbps = Number.isFinite(durationSec) && durationSec > 0
            ? Math.floor((file.size * 8) / durationSec / 1000)
            : null;
        const bitrate = Number.isFinite(avgKbps) && avgKbps > 0 ? avgKbps : DEFAULT_PROPS.bitrate;
        return { tags, props: { duration, bitrate, samplerate: DEFAULT_PROPS.samplerate } };
    }
}

export async function readAudioTags(file) {
    const m = await readAudioMetadata(file);
    return m.tags;
}

export async function getAudioProperties(file) {
    const m = await readAudioMetadata(file);
    return m.props;
}

