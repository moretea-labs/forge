import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 4318, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8766' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
