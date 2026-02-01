export function createPaths({ wasm, mountpoint = '/iPod' } = {}) {
    const mp = String(mountpoint || '/iPod');
    const mpPrefix = mp.endsWith('/') ? mp : `${mp}/`;

    function normalizeRelFsPath(relFsPath) {
        return String(relFsPath || '').replace(/^\/+/, '');
    }

    function toVfsPath(relFsPath) {
        const rel = normalizeRelFsPath(relFsPath);
        return `${mpPrefix}${rel}`;
    }

    function toRelFsPathFromVfs(vfsPath) {
        const vp = String(vfsPath || '');
        if (vp.startsWith(mpPrefix)) return vp.slice(mpPrefix.length);
        if (vp.startsWith(mp)) return vp.slice(mp.length).replace(/^\/+/, '');
        return vp.replace(/^\/+/, '');
    }

    function wasmStringCall(funcName, stringArgs = [], otherArgs = []) {
        const ptr = wasm?.wasmCallWithStrings?.(funcName, stringArgs, otherArgs);
        if (!ptr) return null;
        const s = wasm?.wasmGetString?.(ptr);
        wasm?.wasmCall?.('ipod_free_string', ptr);
        return s;
    }

    function toIpodDbPathFromRel(relFsPath) {
        // libgpod conversion expects a slash-prefixed FS path like "/iPod_Control/Music/..."
        const rel = normalizeRelFsPath(relFsPath);
        return wasmStringCall('ipod_path_to_ipod_format', [`/${rel}`]);
    }

    function toRelFsPathFromIpodDbPath(ipodDbPath) {
        const fsPath = wasmStringCall('ipod_path_to_fs_format', [String(ipodDbPath || '')]);
        // fsPath from libgpod typically starts with '/', but we keep canonical rel FS in JS.
        return normalizeRelFsPath(fsPath);
    }

    return {
        mountpoint: mp,
        normalizeRelFsPath,
        toVfsPath,
        toRelFsPathFromVfs,
        toIpodDbPathFromRel,
        toRelFsPathFromIpodDbPath,
    };
}

