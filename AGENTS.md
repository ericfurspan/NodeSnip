# NodeSnip Project Instructions

NodeSnip is a Manifest V3 Chrome extension that captures a user-selected DOM element
as a PNG for clipboard copy or local download. Read `README.md` for user-facing behavior
and setup. Read `STORE_LISTING.md` before release or store-listing work.

## Design

- Follow shadcn/ui conventions: high contrast, outlined icons, tight spacing, and no
  gradients, decorative elements, or drop shadows.
- Keep the interface minimal and deliberate.
- Build injected UI with DOM APIs, not `innerHTML`.

## Commands

```bash
npm run dev
npm test
npm run build
npm run icons
npm run package
```

After every code change, run `npm test` and then `npm run build`. Fix failures caused
by the change. Report pre-existing or environment failures clearly.

Run `npm run package` only when the task requires a new `NodeSnip.zip`. Packaging does
not authorize uploading or publishing it.

## Durable Invariants

- Keep content-script injection on demand. Do not add static `content_scripts` or
  `host_permissions`.
- Keep extension permissions limited to `activeTab`, `scripting`, and `clipboardWrite`
  unless the task explicitly requires and justifies a change.
- Reject extension messages when `sender.id !== chrome.runtime.id`.
- Track injected top-level nodes by exact reference so page-owned IDs or attributes
  cannot impersonate NodeSnip UI.
- Keep capture logic in `src/capture.js`; it accepts an element and returns a
  `Promise<Blob>` without depending on picker state.
- Keep CSS Color 4 normalization in `src/color-utils.js` and the SVG rectangle guard
  in its dedicated module. Do not merge unrelated capture workarounds.
- `dist/background.js` and `dist/content.js` must remain classic scripts with no
  `import` or `export`, and the build must not emit `dist/chunks/`. The production
  build enforces this invariant.
- Preserve graceful handling for restricted pages, cross-origin frames, detached
  elements, blocked images, and capture failures.

## Release Boundaries

- Store assets live under `screenshots/` and do not ship in the extension package.
- The store icon is uploaded separately from the packaged extension.
- Version changes must stay synchronized between `package.json`, `manifest.json`,
  release-facing documentation, and the packaged ZIP when one is requested.
- Uploading, submitting for review, or publishing requires separate explicit approval.
