import { defineConfig } from 'vite';

// `npm run dev` serves the app with hot reload and forwards /relay and /glove to the relay on :8787
// (start it with `npm run relay`). `npm start` builds and lets the relay serve dist/ itself.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/relay': { target: 'ws://localhost:8787', ws: true },
      '/glove': 'http://localhost:8787',
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
