import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// import-core lives inside supabase/functions/_shared so Edge Functions can
// import it with a relative path; the browser reaches it through this alias
// (spec 14.2: one implementation, two runtimes).
const importCore = fileURLToPath(new URL('./supabase/functions/_shared/import-core', import.meta.url));
// The per-chunk extractor. The Edge Function imports it relatively; the
// browser runs the same file when the local engine does the extraction.
const importExtract = fileURLToPath(new URL('./supabase/functions/import-extract', import.meta.url));
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const modelsDir = path.join(repoRoot, 'models');

// Serve the local model files with Range support, so a big GGUF can be read
// in parts. The files are never committed; a clinic copies them to the PC
// that runs the import.
function modelMiddleware() {
  return (req, res, next) => {
    if (!req.url || !req.url.startsWith('/models/')) return next();
    const relative = decodeURIComponent(req.url.replace(/^\/models\//, '').split('?')[0]);
    // A path that walks out of the models folder is refused.
    if (relative.includes('..') || relative.includes('\0')) return next();
    const filePath = path.join(modelsDir, relative);
    if (!filePath.startsWith(modelsDir + path.sep)) return next();
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next();

    const total = fs.statSync(filePath).size;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', relative.endsWith('.json') ? 'application/json' : 'application/octet-stream');

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : total - 1;
        if (start >= total || end >= total || start > end) {
          res.status = 416;
          res.setHeader('Content-Range', `bytes */${total}`);
          res.end();
          return;
        }
        res.status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.setHeader('Content-Length', String(total));
    fs.createReadStream(filePath).pipe(res);
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@import-core': importCore,
      '@import-extract': importExtract,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Ship syntax older mobile WebViews can parse. `es2022` produced class
    // fields / `?.` / `??` that a stock Android WebView (and some in-app
    // browsers) reject with a SyntaxError, which left the whole app behind
    // `x-cloak` and showed a blank page. `es2019` is Chrome 73 / Android 10.
    target: 'es2019',
    // The model runtimes are large and are loaded on demand.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      // The OCR runtime (ONNX Runtime and the tokenizer library) adds tens of
      // megabytes of wasm, which does not fit the hosting. The OCR path is
      // dark until it ships with its own build; until then the import fails
      // at runtime and the code says so.
      external: ['onnxruntime-web', '@huggingface/transformers'],
    },
  },
  server: {
    port: 3000,
    open: true,
    fs: {
      // The dev server must serve the shared folder outside src/.
      allow: [fileURLToPath(new URL('.', import.meta.url))],
    },
  },
  preview: {
    port: 3000,
  },
  plugins: [
    {
      name: 'local-model-middleware',
      configureServer(server) { server.middlewares.use(modelMiddleware()); },
      configurePreviewServer(server) { server.middlewares.use(modelMiddleware()); },
    },
  ],
  optimizeDeps: {
    // The model runtimes ship their own wasm and must not be pre-bundled.
    exclude: ['onnxruntime-web', '@wllama/wllama', '@huggingface/transformers'],
  },
});
