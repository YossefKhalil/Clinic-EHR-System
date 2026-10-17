import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Vitest reuses the Vite config so tests resolve `@import-core` exactly like
// the app build does.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
}));
