import { defineConfig } from 'vite';

export default defineConfig({
  root: 'source',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
