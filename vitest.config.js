import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Vitest reuses the Vite config so tests resolve `@import-core` exactly like
// the app build does.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // The rules engine is shared by browser and Edge Functions; its
      // milestone gate is branch coverage on the normalizers (spec 18.1 M1).
      include: ['supabase/functions/_shared/import-core/**/*.js'],
      exclude: ['supabase/functions/_shared/import-core/index.js'],
      reporter: ['text'],
      thresholds: {
        '**/normalizers.js': { branches: 95 },
      },
    },
  },
}));
