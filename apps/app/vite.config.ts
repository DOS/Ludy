import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.CROVE_API_URL ?? 'http://localhost:8080';
// The build this bundle ships with (#2261). On Vercel the release commit; the page compares it with the API's /version and
// asks for a reload on a mismatch. Unset (the kernel's own image serves the matching bundle): no comparison.
const build = process.env.VITE_BUILD ?? process.env.VERCEL_GIT_COMMIT_SHA ?? '';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'import.meta.env.VITE_BUILD': JSON.stringify(build) },
  server: {
    port: 5173,
    proxy: { '/api': api, '/auth': api },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Fonts always ship as files: the kernel's CSP (default-src 'self') would block a font inlined as a data: URI,
    // which Vite does by default for assets under 4 KB.
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
});
