// src/target.js
//
// The active build target: 'chrome' (html2canvas) or 'firefox' (native
// chrome.tabs.captureTab) — see the branch in src/capture.js. Baked in at build
// time by the Vite `define` constant __NODESNIP_TARGET__, set per target in
// scripts/build.mjs and defaulted to 'chrome' in vite.config.js for `vite dev`
// and Vitest, neither of which runs a per-target build.
//
// Kept in this one-line module, rather than referencing __NODESNIP_TARGET__
// directly at each call site, so a test can select the Firefox path with
// vi.mock('../src/target.js', () => ({ TARGET: 'firefox' })) instead of depending
// on which per-target build produced the code under test.
export const TARGET = __NODESNIP_TARGET__
