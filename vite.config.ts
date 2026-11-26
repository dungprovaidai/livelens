import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const managedPreview = process.env.SITES_MANAGED_LINUX_CONTAINER === '1';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: managedPreview ? undefined : { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } }
  }
});
