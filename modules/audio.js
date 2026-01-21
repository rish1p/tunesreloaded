/**
 * Audio helpers (tags + duration) that work in the browser.
 */

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

export function readAudioTags(file) {
    return new Promise((resolve) => {
        if (typeof globalThis.jsmediatags === 'undefined') {
            resolve({
                title: file.name.replace(/\.[^/.]+$/, ''),
                artist: 'Unknown Artist',
                album: 'Unknown Album',
                genre: '',
                track: 0,
                year: 0,
            });
            return;
        }

        globalThis.jsmediatags.read(file, {
            onSuccess: (tag) => {
                const tags = tag.tags || {};
                resolve({
                    title: tags.title || file.name.replace(/\.[^/.]+$/, ''),
                    artist: tags.artist || 'Unknown Artist',
                    album: tags.album || 'Unknown Album',
                    genre: tags.genre || '',
                    track: tags.track ? parseInt(tags.track) : 0,
                    year: tags.year ? parseInt(tags.year) : 0,
                });
            },
            onError: () => {
                const title = file.name.replace(/\.[^/.]+$/, '');
                const match = title.match(/^(.+?)\s*-\s*(.+)$/);
                resolve({
                    title: match ? match[2].trim() : title,
                    artist: match ? match[1].trim() : 'Unknown Artist',
                    album: 'Unknown Album',
                    genre: '',
                    track: 0,
                    year: 0,
                });
            }
        });
    });
}

export async function getAudioProperties(file) {
    // IMPORTANT: Never return NaN/Infinity here.
    // Emscripten coerces NaN/Infinity to 0 for int args, producing 0:00 durations on-device.
    const DEFAULT = { duration: 180000, bitrate: 192, samplerate: 44100 }; // 3:00 fallback

    // Fast path: HTMLAudioElement metadata (can be Infinity for some MP3s).
    const meta = await new Promise((resolve) => {
        const audio = new Audio();
        audio.preload = 'metadata';

        const cleanup = () => {
            try { if (audio.src) URL.revokeObjectURL(audio.src); } catch (_) {}
            audio.removeAttribute('src');
            try { audio.load(); } catch (_) {}
        };

        audio.onloadedmetadata = () => {
            const durationSec = audio.duration;
            cleanup();
            resolve({ durationSec });
        };

        audio.onerror = () => {
            cleanup();
            resolve({ durationSec: null });
        };

        audio.src = URL.createObjectURL(file);
    });

    let durationSec = meta.durationSec;

    // Robust fallback: decode to get a real duration when metadata is missing/Infinity/NaN/0.
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        try {
            const buf = await file.arrayBuffer();
            const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (Ctx) {
                const ctx = new Ctx();
                const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
                durationSec = audioBuffer?.duration;
                try { await ctx.close(); } catch (_) {}
            }
        } catch (_) {
            // ignore; we'll fall back below
        }
    }

    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return DEFAULT;
    }

    const duration = Math.max(1, Math.floor(durationSec * 1000)); // ms; clamp to non-zero
    const bitrate = Math.floor((file.size * 8) / durationSec / 1000);
    return { duration, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 128, samplerate: 44100 };
}

