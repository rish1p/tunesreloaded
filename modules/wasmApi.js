export function createWasmApi({ log, createModule = globalThis.createIPodModule } = {}) {
    let wasmReady = false;
    let Module = null;

    async function initWasm() {
        log?.('Loading WASM module...');
        try {
            if (typeof createModule !== 'function') {
                throw new Error('createIPodModule not found (is ipod_manager.js loaded?)');
            }
            Module = await createModule({
                print: (text) => log?.(text, 'info'),
                printErr: (text) => log?.(text, 'error'),
            });
            wasmReady = true;
            log?.('WASM module initialized', 'success');
            return true;
        } catch (e) {
            log?.(`Failed to load WASM: ${e.message}`, 'error');
            wasmReady = false;
            Module = null;
            return false;
        }
    }

    function isReady() {
        return wasmReady;
    }

    function getModule() {
        return Module;
    }

    function wasmCall(funcName, ...args) {
        if (!wasmReady || !Module) {
            log?.(`WASM not ready, cannot call ${funcName}`, 'error');
            return null;
        }
        try {
            const func = Module[`_${funcName}`];
            if (!func) {
                log?.(`WASM function not found: ${funcName}`, 'error');
                return null;
            }
            return func(...args);
        } catch (e) {
            log?.(`WASM call error (${funcName}): ${e.message}`, 'error');
            return null;
        }
    }

    function wasmGetString(ptr) {
        return ptr && Module ? Module.UTF8ToString(ptr) : null;
    }

    function wasmAllocString(str) {
        const s = String(str ?? '');
        const len = Module.lengthBytesUTF8(s) + 1;
        const ptr = Module._malloc(len);
        Module.stringToUTF8(s, ptr, len);
        return ptr;
    }

    function wasmFreeString(ptr) {
        if (ptr && Module) Module._free(ptr);
    }

    function wasmCallWithStrings(funcName, stringArgs = [], otherArgs = []) {
        if (!Module) return null;
        const stringPtrs = stringArgs.map(wasmAllocString);
        try {
            return wasmCall(funcName, ...stringPtrs, ...otherArgs);
        } finally {
            stringPtrs.forEach(wasmFreeString);
        }
    }

    function wasmGetJson(funcName, ...args) {
        const jsonPtr = wasmCall(funcName, ...args);
        if (!jsonPtr) return null;

        const jsonStr = wasmGetString(jsonPtr);
        wasmCall('ipod_free_string', jsonPtr);
        if (!jsonStr) return null;

        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            log?.(`Failed to parse JSON from ${funcName}: ${e.message}`, 'error');
            return null;
        }
    }

    function wasmCallWithError(funcName, ...args) {
        const result = wasmCall(funcName, ...args);
        if (result !== 0 && result !== null) {
            const errorPtr = wasmCall('ipod_get_last_error');
            const error = wasmGetString(errorPtr);
            log?.(`WASM error (${funcName}): ${error || 'Unknown error'}`, 'error');
        }
        return result;
    }

    function wasmAddTrack({
        title,
        artist,
        album,
        genre,
        trackNr = 0,
        cdNr = 0,
        year = 0,
        durationMs,
        bitrateKbps,
        samplerateHz,
        sizeBytes,
        filetype,
    }) {
        if (!wasmReady || !Module?.ccall) return -1;

        const safeTitle = title || '';
        const safeArtist = artist || 'Unknown Artist';
        const safeAlbum = album || 'Unknown Album';
        const safeGenre = genre || '';
        const safeFiletype = filetype || 'MPEG audio file';

        const safeTrackNr = Number.isFinite(trackNr) ? trackNr : 0;
        const safeCdNr = Number.isFinite(cdNr) ? cdNr : 0;
        const safeYear = Number.isFinite(year) ? year : 0;
        const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 180000;
        const safeBitrate = Number.isFinite(bitrateKbps) && bitrateKbps > 0 ? bitrateKbps : 128;
        const safeSamplerate = Number.isFinite(samplerateHz) && samplerateHz > 0 ? samplerateHz : 44100;
        const safeSize = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;

        return Module.ccall(
            'ipod_add_track',
            'number',
            ['string','string','string','string','number','number','number','number','number','number','number','string'],
            [safeTitle, safeArtist, safeAlbum, safeGenre, safeTrackNr, safeCdNr, safeYear, safeDurationMs, safeBitrate, safeSamplerate, safeSize, safeFiletype]
        );
    }

    function wasmSetTrackArtwork(trackIndex, imageBytes) {
        if (!wasmReady || !Module?.ccall) return -1;
        const bytes = new Uint8Array(imageBytes);
        if (bytes.length === 0) {
            log?.('Artwork image is empty', 'error');
            return -1;
        }
        // The caller (metadataEditor) pre-resizes artwork to ≤320×320 JPEG,
        // so the payload is typically 20-50 KB — well within Emscripten's
        // stack limit.  Using ccall with 'array' is the most portable way
        // to pass binary data since this build does not expose HEAPU8 or
        // wasmMemory on the Module object.
        try {
            const result = Module.ccall(
                'ipod_track_set_artwork_from_data',
                'number',
                ['number', 'array', 'number'],
                [trackIndex, bytes, bytes.length]
            );
            if (result !== 0) {
                const errorPtr = wasmCall('ipod_get_last_error');
                log?.(`WASM error (ipod_track_set_artwork_from_data): ${wasmGetString(errorPtr) || 'Unknown error'}`, 'error');
            }
            return result;
        } catch (e) {
            log?.(`Failed to set artwork: ${e.message}`, 'error');
            return -1;
        }
    }

    /**
     * Set a track's artwork from pre-decoded RGBA pixel data.
     *
     * The caller decodes the image via Canvas, resizes to the desired
     * dimensions, and extracts raw RGBA via getImageData().  This avoids
     * needing any image-format loaders on the C/WASM side.
     *
     * The RGBA payload for 320×320 is ~400 KB which fits comfortably in
     * Emscripten's default 5 MB stack (ccall 'array' uses stackAlloc).
     *
     * @param {number} trackIndex  Track list index.
     * @param {Uint8Array} rgbaData  Raw RGBA pixel bytes.
     * @param {number} width   Image width.
     * @param {number} height  Image height.
     * @returns {number} 0 = success, -1 = error, -2 = GdkPixbuf not available.
     */
    function wasmSetTrackArtworkRGBA(trackIndex, rgbaData, width, height) {
        if (!wasmReady || !Module?.ccall) return -1;
        const bytes = new Uint8Array(rgbaData);
        if (bytes.length === 0) {
            log?.('RGBA artwork data is empty', 'error');
            return -1;
        }
        const expected = width * height * 4;
        if (bytes.length !== expected) {
            log?.(`RGBA data length mismatch: expected ${expected}, got ${bytes.length}`, 'error');
            return -1;
        }
        try {
            const result = Module.ccall(
                'ipod_track_set_artwork_from_rgba',
                'number',
                ['number', 'array', 'number', 'number', 'number'],
                [trackIndex, bytes, bytes.length, width, height]
            );
            if (result === -2) {
                log?.('Artwork requires a WASM build with GdkPixbuf. See build.sh.', 'error');
            } else if (result !== 0) {
                const errorPtr = wasmCall('ipod_get_last_error');
                log?.(`WASM error (ipod_track_set_artwork_from_rgba): ${wasmGetString(errorPtr) || 'Unknown error'}`, 'error');
            }
            return result;
        } catch (e) {
            log?.(`Failed to set RGBA artwork: ${e.message}`, 'error');
            return -1;
        }
    }

    function wasmUpdateTrack(trackIndex, { title, artist, album, genre, trackNr = -1, year = -1, rating = -1 } = {}) {
        if (!wasmReady || !Module?.ccall) return -1;

        // Pass null to skip a string field (C checks `if (title)` before updating).
        // Pass '' or a string to update. Never coerce empty → '' since that would clear the field.
        const safeTitle  = (title  != null && title  !== '') ? String(title)  : null;
        const safeArtist = (artist != null && artist !== '') ? String(artist) : null;
        const safeAlbum  = (album  != null && album  !== '') ? String(album)  : null;
        const safeGenre  = (genre  != null && genre  !== '') ? String(genre)  : null;

        // Pass -1 to skip an int field (C checks `if (field >= 0)` before updating).
        const safeTrackNr = Number.isFinite(trackNr) && trackNr >= 0 ? Math.floor(trackNr) : -1;
        const safeYear    = Number.isFinite(year)    && year    >  0 ? Math.floor(year)    : -1;
        const safeRating  = Number.isFinite(rating)  && rating  >= 0 ? Math.floor(rating)  : -1;

        const result = Module.ccall(
            'ipod_update_track',
            'number',
            ['number', 'string', 'string', 'string', 'string', 'number', 'number', 'number'],
            [trackIndex, safeTitle, safeArtist, safeAlbum, safeGenre, safeTrackNr, safeYear, safeRating]
        );
        if (result !== 0) {
            const errorPtr = wasmCall('ipod_get_last_error');
            log?.(`WASM error (ipod_update_track): ${wasmGetString(errorPtr) || 'Unknown error'}`, 'error');
        }
        return result;
    }

    return {
        initWasm,
        isReady,
        getModule,
        wasmCall,
        wasmGetString,
        wasmAllocString,
        wasmFreeString,
        wasmCallWithStrings,
        wasmGetJson,
        wasmCallWithError,
        wasmAddTrack,
        wasmUpdateTrack,
        wasmSetTrackArtwork,
        wasmSetTrackArtworkRGBA,
    };
}

