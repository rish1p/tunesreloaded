export function createFsSync({ log, wasm, mountpoint = '/iPod' }) {
    function getFS() {
        const Module = wasm.getModule();
        return Module?.FS;
    }

    async function verifyIpodStructure(handle) {
        try {
            const controlDir = await handle.getDirectoryHandle('iPod_Control', { create: false });
            const itunesDir = await controlDir.getDirectoryHandle('iTunes', { create: false });
            await itunesDir.getFileHandle('iTunesDB', { create: false });
            log('Found iPod_Control directory', 'success');
            return true;
        } catch (_) {
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

        const iPodControlHandle = await handle.getDirectoryHandle('iPod_Control');
        const iTunesHandle = await iPodControlHandle.getDirectoryHandle('iTunes');

        // Copy iTunesDB
        const dbFileHandle = await iTunesHandle.getFileHandle('iTunesDB');
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

    async function copyFileToVirtualFS(data, virtualPath) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');
        try {
            const parts = virtualPath.split('/').filter(p => p);
            let dirPath = '';
            for (let i = 0; i < parts.length - 1; i++) {
                dirPath += '/' + parts[i];
                try { FS.mkdir(dirPath); } catch (_) {}
            }
            FS.writeFile(virtualPath, data);
        } catch (e) {
            log(`Virtual FS write warning: ${e.message}`, 'warning');
        }
    }

    async function syncVirtualFSToIpod(ipodHandle) {
        if (!ipodHandle) return;
        log('Syncing changes to iPod...');
        try {
            await syncVirtualFileToReal(ipodHandle, `${mountpoint}/iPod_Control/iTunes/iTunesDB`, ['iPod_Control', 'iTunes'], 'iTunesDB');
            await syncVirtualFileToReal(ipodHandle, `${mountpoint}/iPod_Control/iTunes/iTunesSD`, ['iPod_Control', 'iTunes'], 'iTunesSD', true);
            await syncMusicFilesToReal(ipodHandle);
            log('Sync complete', 'success');
        } catch (e) {
            log(`Sync error: ${e.message || e.toString() || 'Unknown error'}`, 'error');
        }
    }

    async function syncMusicFilesToReal(ipodHandle) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        try {
            const vfsMusicPath = `${mountpoint}/iPod_Control/Music`;
            let folders;
            try {
                folders = FS.readdir(vfsMusicPath).filter(f => f.match(/^F\d{2}$/i));
            } catch (_) {
                return;
            }
            if (folders.length === 0) return;

            const iPodControlHandle = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
            const musicHandle = await iPodControlHandle.getDirectoryHandle('Music', { create: true });

            for (const folder of folders) {
                const folderPath = `${vfsMusicPath}/${folder}`;
                let files;
                try {
                    files = FS.readdir(folderPath).filter(f => /\.(mp3|m4a|aac|wav|aiff)$/i.test(f));
                } catch (_) {
                    continue;
                }
                if (files.length === 0) continue;

                const realFolderHandle = await musicHandle.getDirectoryHandle(folder, { create: true });

                for (const file of files) {
                    const filePath = `${folderPath}/${file}`;
                    try {
                        try {
                            await realFolderHandle.getFileHandle(file);
                            continue; // File already exists
                        } catch (_) {}

                        const fileData = FS.readFile(filePath);
                        const fileHandle = await realFolderHandle.getFileHandle(file, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(fileData);
                        await writable.close();
                        log(`Synced music file: ${folder}/${file}`, 'info');
                    } catch (e) {
                        log(`Could not sync ${folder}/${file}: ${e.message}`, 'warning');
                    }
                }
            }
        } catch (e) {
            log(`Error syncing music files: ${e.message}`, 'warning');
        }
    }

    async function syncVirtualFileToReal(ipodHandle, virtualPath, dirPath, fileName, optional = false) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        try {
            try {
                FS.stat(virtualPath);
            } catch (_) {
                if (!optional) log(`File not found in virtual FS: ${virtualPath}`, 'warning');
                return;
            }

            const data = FS.readFile(virtualPath);
            let currentDir = ipodHandle;
            for (const dir of dirPath) {
                currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
            }

            const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(data);
            await writable.close();
            log(`Synced ${fileName} to iPod`, 'info');
        } catch (e) {
            if (!optional) log(`Failed to sync ${fileName}: ${e.message}`, 'warning');
        }
    }

    return {
        mountpoint,
        verifyIpodStructure,
        setupWasmFilesystem,
        syncVirtualFSToIpod,
        copyFileToVirtualFS,
    };
}

