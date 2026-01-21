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
    };
}

