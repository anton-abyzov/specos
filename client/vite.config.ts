import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

// The server serves the built client, so there is no dev server to expose.
// SPECOS_OUT_DIR lets parallel end-to-end runs build into their own folder.
export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(here, '../shared'),
      '@': path.resolve(here, 'src'),
    },
  },
  build: {
    outDir: process.env.SPECOS_OUT_DIR ? path.resolve(process.env.SPECOS_OUT_DIR) : path.resolve(here, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
