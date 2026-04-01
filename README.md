# TunesReloaded

[TunesReloaded](https://tunesreloaded.com) is a web-based classic iPod tool to add/manage songs directly, including .mp3's and .flacs. It runs entirely in the browser and uses the File System Access API to read and write directly to an iPod.

## Features

- Manage tracks and playlists from the iPod’s database
- Add/remove tracks via file picker or drag-and-drop, then sync in one batch 
- Native .flac upload support!
- Supports all legacy iPod's (with 30-pin connector, non touch)*
- Mac, Windows, Linux, ChromeOS are all supported!
## Quickstart
![TunesReloaded screenshot](assets/ipod_1.png)
![TunesReloaded screenshot](assets/ipod_2.png)


1. Open [TunesReloaded](https://tunesreloaded.com) in a Chromium-based browser (Chrome / Edge).
2. Connect your iPod to your computer.
3. Grant WebUSB permission so the app can identify your iPod model (required for correct database handling).
4. Select the **root folder of the iPod drive** when prompted for file access.
5. Add songs via drag-and-drop or file picker.
6. Click **Sync** to write songs and update the iPod database!
7. Safely disconnect the iPod.


## Background

To identify the iPod model (as database encryption / writing depends on this), we use WebUSB. Then, for actually writing files/tracks to the iPod, we use the File System Access API. 

The iPod database work is powered by [`libgpod`](https://github.com/fadingred/libgpod), compiled to WebAssembly so it can parse and write the iPod’s `iTunesDB` in the browser. 

For FLAC support, the app uses [`ffmpeg.wasm`](https://github.com/ffmpegwasm/ffmpeg.wasm) to transcode `.flac` files into ALAC-encoded files that the iPod can play.

For reduced memory usage, we stream music files directly to the iPod during sync (no full-file staging in browser memory).


## Known issues / limitations

- 6th/7th gen iPod nano support is in beta, file an issue or email info@tunesreloaded.com if you run into issues
- No album artwork support yet
- Performance may be limited when uploading FLAC's due to high transcoding CPU usage. 

If you find any other issues, please don't hesitate to open an issue request or send an email, with logs: info@tunesreloaded.com
## Development

Coming soon! 

## Support
If you found this tool helpful, please consider supporting development through [buying a coffee](https://buymeacoffee.com/riship1). I lose money on this endeavor through hosting + development costs, but I am passionate and committed to keep the new spirit of these old iPod's alive. All support is appreciated!
