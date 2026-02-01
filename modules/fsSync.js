export function createFsSync({ log, wasm, mountpoint = '/iPod' }) {
    function getFS() {
        const Module = wasm.getModule();
        return Module?.FS;
    }

    async function listDirNames(dirHandle, limit = 50) {
        const names = [];
        try {
            for await (const [name] of dirHandle.entries()) {
                names.push(name);
                if (names.length >= limit) break;
            }
        } catch (_) {
            // ignore
        }
        names.sort((a, b) => a.localeCompare(b));
        return names;
    }

    async function verifyIpodStructure(handle) {
        try {
            const controlDir = await handle.getDirectoryHandle('iPod_Control', { create: false });

            let itunesDir;
            try {
                itunesDir = await controlDir.getDirectoryHandle('iTunes', { create: false });
            } catch (e) {
                const names = await listDirNames(controlDir);
                log(`Missing iPod_Control/iTunes. Found in iPod_Control: ${names.join(', ') || '(empty)'}`, 'error');
                return false;
            }

            try {
                await itunesDir.getFileHandle('iTunesDB', { create: false });
            } catch (e) {
                const names = await listDirNames(itunesDir);
                log(`Missing iPod_Control/iTunes/iTunesDB. Found in iTunes: ${names.join(', ') || '(empty)'}`, 'error');
                return false;
            }

            log('Found iPod_Control/iTunes/iTunesDB', 'success');
            return true;
        } catch (e) {
            const names = await listDirNames(handle);
            log(`Missing iPod_Control in selected folder. Found: ${names.join(', ') || '(empty)'}`, 'error');
            return false;
        }
    }

    async function setupWasmFilesystem(handle) {
        log('Setting up virtual filesystem for WASM...');
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        // Create mountpoint
        try { FS.mkdir(mountpoint); } catch (_) {}

        // Set mountpoint in WASM
        wasm.wasmCallWithStrings('ipod_set_mountpoint', [mountpoint]);

        // Create directory structure
        const dirs = [
            `${mountpoint}/iPod_Control`,
            `${mountpoint}/iPod_Control/iTunes`,
            `${mountpoint}/iPod_Control/Device`,
            `${mountpoint}/iPod_Control/Music`
        ];
        dirs.forEach(dir => { try { FS.mkdir(dir); } catch (_) {} });

        // Create Music subfolders F00-F49
        for (let i = 0; i < 50; i++) {
            const folder = `F${String(i).padStart(2, '0')}`;
            try { FS.mkdir(`${mountpoint}/iPod_Control/Music/${folder}`); } catch (_) {}
        }

        await syncIpodToVirtualFS(handle);
        log('Virtual filesystem ready', 'success');
    }

    async function syncIpodToVirtualFS(handle) {
        log('Syncing iPod files to virtual filesystem...');
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        const iPodControlHandle = await handle.getDirectoryHandle('iPod_Control', { create: false });
        const iTunesHandle = await iPodControlHandle.getDirectoryHandle('iTunes', { create: false });

        // Copy iTunesDB
        const dbFileHandle = await iTunesHandle.getFileHandle('iTunesDB', { create: false });
        const dbFile = await dbFileHandle.getFile();
        const dbData = new Uint8Array(await dbFile.arrayBuffer());
        FS.writeFile(`${mountpoint}/iPod_Control/iTunes/iTunesDB`, dbData);
        log(`Synced: iTunesDB (${dbData.length} bytes)`, 'info');

        // Copy SysInfo and SysInfoExtended (optional)
        try {
            const deviceHandle = await iPodControlHandle.getDirectoryHandle('Device');
            await copyDeviceFile(deviceHandle, 'SysInfo');
            await copyDeviceFile(deviceHandle, 'SysInfoExtended');
        } catch (e) {
            log(`Device directory error: ${e.message}`, 'warning');
        }

        log('File sync complete', 'success');
    }

    async function copyDeviceFile(deviceHandle, filename) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');
        try {
            const fileHandle = await deviceHandle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            const data = new Uint8Array(await file.arrayBuffer());
            FS.writeFile(`${mountpoint}/iPod_Control/Device/${filename}`, data);
            log(`Synced: ${filename} (${data.length} bytes)`, 'info');
        } catch (e) {
            if (filename === 'SysInfo') {
                log(`SysInfo file not found: ${e.message}`, 'warning');
            }
        }
    }

    // Reserve a destination path in MEMFS (empty file) to avoid name collisions
    // when libgpod generates random filenames based on filesystem existence checks.
    function reserveVirtualPath(virtualPath) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');
        const vp = String(virtualPath || '');
        if (!vp) return;

        try {
            // Ensure parent directories exist
            const parts = vp.split('/').filter(p => p);
            let dirPath = '';
            for (let i = 0; i < parts.length - 1; i++) {
                dirPath += '/' + parts[i];
                try { FS.mkdir(dirPath); } catch (_) {}
            }

            // If file already exists, keep it
            try {
                FS.stat(vp);
                return;
            } catch (_) {
                // create empty placeholder
            }
            FS.writeFile(vp, new Uint8Array());
        } catch (_) {
            // best-effort only
        }
    }

    async function writeFileToIpodRelativePath(ipodHandle, relativePath, file, { onProgress } = {}) {
        if (!ipodHandle) throw new Error('No iPod handle');
        if (!file) throw new Error('No file provided');

        const parts = String(relativePath || '').split('/').filter(Boolean);
        if (parts.length === 0) throw new Error('Invalid destination path');

        const fileName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);

        // Create directories as needed
        let currentDir = ipodHandle;
        for (const dir of dirParts) {
            currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
        }

        const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();

        // Use native stream piping for better throughput (still constant-memory).
        // If progress is needed, count bytes via a TransformStream.
        const total = Number(file.size || 0);
        let readable = file.stream();

        if (typeof onProgress === 'function' && total > 0) {
            let written = 0;
            readable = readable.pipeThrough(new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(chunk);
                    written += chunk?.byteLength || 0;
                    const percent = Math.round((written / total) * 100);
                    try { onProgress({ written, total, percent }); } catch (_) {}
                }
            }));
        }

        try {
            // pipeTo will close the destination stream on success.
            await readable.pipeTo(writable);
        } catch (e) {
            // Best-effort abort to release the file handle.
            try { await writable.abort(e); } catch (_) {}
            throw e;
        }
    }

    async function syncDbToIpod(ipodHandle, { onProgress } = {}) {
        if (!ipodHandle) return { ok: false, errorCount: 1, syncedCount: 0, skippedCount: 0 };

        const tasks = [
            { virtualPath: `${mountpoint}/iPod_Control/iTunes/iTunesDB`, dirPath: ['iPod_Control', 'iTunes'], fileName: 'iTunesDB', optional: false },
            { virtualPath: `${mountpoint}/iPod_Control/iTunes/iTunesSD`, dirPath: ['iPod_Control', 'iTunes'], fileName: 'iTunesSD', optional: true },
        ];

        let done = 0;
        const total = tasks.length;
        let errorCount = 0;
        let syncedCount = 0;

        const report = (detail) => {
            done += 1;
            const percent = Math.round((done / total) * 100);
            try { onProgress?.({ phase: 'ipod', current: done, total, percent, detail }); } catch (_) {}
        };

        const iPodControlHandle = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
        const iTunesHandle = await iPodControlHandle.getDirectoryHandle('iTunes', { create: true });

        for (const t of tasks) {
            const ok = await syncVirtualFileToRealInternal(iTunesHandle, t.virtualPath, t.fileName, t.optional);
            if (!ok && !t.optional) errorCount += 1;
            if (ok) syncedCount += 1;
            report(t.fileName);
        }

        return { ok: errorCount === 0, errorCount, syncedCount, skippedCount: 0 };
    }

    async function syncVirtualFileToRealInternal(realDirHandle, virtualPath, fileName, optional = false) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        try {
            try {
                FS.stat(virtualPath);
            } catch (_) {
                if (!optional) log(`File not found in virtual FS: ${virtualPath}`, 'warning');
                return false;
            }

            const data = FS.readFile(virtualPath);
            const fileHandle = await realDirHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(data);
            await writable.close();
            log(`Synced ${fileName} to iPod`, 'info');
            return true;
        } catch (e) {
            if (!optional) log(`Failed to sync ${fileName}: ${e.message}`, 'warning');
            return false;
        }
    }

    async function deleteFileFromIpodRelativePath(ipodHandle, relativePath) {
        if (!ipodHandle) throw new Error('No iPod handle');
        const parts = String(relativePath || '').split('/').filter(Boolean);
        if (parts.length === 0) throw new Error('Invalid destination path');

        const fileName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);

        let currentDir = ipodHandle;
        for (const dir of dirParts) {
            currentDir = await currentDir.getDirectoryHandle(dir, { create: false });
        }

        // Spec: FileSystemDirectoryHandle.removeEntry(name, { recursive? })
        await currentDir.removeEntry(fileName, { recursive: false });
    }

    return {
        mountpoint,
        verifyIpodStructure,
        setupWasmFilesystem,
        syncDbToIpod,
        writeFileToIpodRelativePath,
        reserveVirtualPath,
        deleteFileFromIpodRelativePath,
    };
}

