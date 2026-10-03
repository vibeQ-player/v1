import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { home: fileURLToPath(new URL('./index.html', import.meta.url)), player: fileURLToPath(new URL('./player/index.html', import.meta.url)) } } },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3001' } },
});
