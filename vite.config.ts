import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // Dedicated port + strictPort — electron/main.ts's dev-mode loadURL is
    // hardcoded to this same port. A silent fallback to a free port (the old
    // behavior) meant Electron would load whatever else happened to be
    // sitting on 5173 instead — concretely, GoBilling's own unrelated dev
    // server, so the RaSetu Electron window rendered GoBilling's UI. Fail
    // loudly instead: if this port's taken, that's a real problem to fix,
    // not something to paper over.
    port: process.env.PORT ? parseInt(process.env.PORT) : 5183,
    strictPort: true,
  },
});
