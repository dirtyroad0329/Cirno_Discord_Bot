import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  base: '/web/',
  plugins: [vue()],
  envDir: false,
  build: { outDir: '../dist/client', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/web/api': { target: 'http://127.0.0.1:3100', changeOrigin: false },
      '/web/upload': { target: 'http://127.0.0.1:3100', changeOrigin: false },
    },
  },
});
