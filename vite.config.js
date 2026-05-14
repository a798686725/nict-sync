import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'src-tauri/dist',
    emptyOutDir: true,
  },
  server: {
    port: 1420,
  },
});
