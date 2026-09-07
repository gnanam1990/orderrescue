import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5319,
    proxy: { '/v1': 'http://127.0.0.1:4319', '/ready': 'http://127.0.0.1:4319', '/health': 'http://127.0.0.1:4319' },
  },
});
