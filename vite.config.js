import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// import-core lives inside supabase/functions/_shared so Edge Functions can
// import it with a relative path; the browser reaches it through this alias
// (spec 14.2: one implementation, two runtimes).
const importCore = fileURLToPath(new URL('./supabase/functions/_shared/import-core', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@import-core': importCore,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    open: true,
    fs: {
      // The dev server must serve the shared folder outside src/.
      allow: [fileURLToPath(new URL('.', import.meta.url))],
    },
  },
});
