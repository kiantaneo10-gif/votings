import { defineConfig } from 'vite';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  plugins: [{
    name: 'web-index-html',
    closeBundle() {
      copyFileSync(`${projectRoot}dist/Votings.html`, `${projectRoot}dist/index.html`);
    }
  }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: `${projectRoot}Votings.html`
      }
    }
  }
});
