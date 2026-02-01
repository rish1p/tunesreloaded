import { defineConfig } from 'vite';

// Minimal config: keep this repo layout, bundle main.js graph,
// and serve static assets (like ipod_manager.js/.wasm) from /public.
export default defineConfig({
  optimizeDeps: {
    // ffmpeg.wasm spawns a module worker; Vite's dep optimizer can break the worker URL
    // and produce missing ".../.vite/deps/worker.js?worker_file&type=module" errors.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  server: {
    port: 8080,
    strictPort: true,
    headers: {
      // Required for SharedArrayBuffer (ffmpeg.wasm) in modern browsers.
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
});

