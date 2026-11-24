import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  clearScreen: false,
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 14730, strictPort: true },
  build: {
    target: 'es2022', sourcemap: false, reportCompressedSize: true,
    rollupOptions: { output: { manualChunks(id) { if (id.includes('node_modules') && (id.includes('reka-ui') || id.includes('@floating-ui'))) return 'interaction-primitives'; } } },
  },
});
