import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Kept separate from vite.config.ts so the app build never carries test-only
// settings. mergeConfig reuses the real plugin/resolve setup, so a component
// under test compiles exactly the way it does in a build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Terminal, toast and SFTP code all touch the DOM, so a browser-like
      // environment is the default rather than an opt-in per file.
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      // wailsjs is generated glue around a runtime that only exists inside
      // WebView2; nothing there is meaningful to unit test.
      exclude: ['node_modules', 'dist', 'wailsjs'],
      restoreMocks: true,
      coverage: {
        provider: 'v8',
        reportsDirectory: './coverage',
        // Reported for information only. No global threshold: this suite starts
        // from zero, and a number picked now would either be met by trivia or
        // block honest incremental work.
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**', 'src/vite-env.d.ts'],
      },
    },
  }),
)
