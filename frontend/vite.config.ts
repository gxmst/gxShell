import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // The only runtime is the WebView2 Chromium the app ships against, so the
    // default 'baseline-widely-available' target would downlevel syntax that
    // already runs natively here. Naming a modern target keeps the output
    // closer to the source.
    target: 'chrome120',
    rollupOptions: {
      output: {
        // xterm and React are needed at startup, so splitting them does not
        // make the app boot faster. It does keep them in files that survive
        // app-code changes, so an update only invalidates the small chunk.
        manualChunks: {
          xterm: [
            '@xterm/xterm',
            '@xterm/addon-fit',
            '@xterm/addon-search',
            '@xterm/addon-unicode11',
            '@xterm/addon-webgl',
          ],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
})
