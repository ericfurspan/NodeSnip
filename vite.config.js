import { defineConfig } from 'vite'

// Build is orchestrated by scripts/build.mjs (see the comment there). This config
// holds the shared build output options it reuses, plus the Vitest configuration.
//
// Note there is no `codeSplitting: false` here: Rolldown rejects it for a
// multi-entry build. Nothing is shared between the two entries today, so no chunk
// is emitted — and scripts/build.mjs asserts that after every build, since a shared
// chunk would make the entries `import`, which is fatal for classic scripts.
export const sharedOutput = {
  entryFileNames: '[name].js',
  assetFileNames: 'assets/[name].[ext]',
  format: 'es',
}

// __NODESNIP_TARGET__ (see src/target.js) picks the capture path in
// src/capture.js: 'chrome' (html2canvas) or 'firefox' (native
// chrome.tabs.captureTab). scripts/build.mjs's own vite.build() call
// (configFile: false, so it does not read this file) sets the real value per
// target; the default here only covers `vite dev` and Vitest, so both exercise
// the Chrome path unless a test stubs src/target.js.
export default defineConfig({
  define: {
    __NODESNIP_TARGET__: JSON.stringify('chrome'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
  },
})
