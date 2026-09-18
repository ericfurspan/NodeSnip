// scripts/firefox-manifest.mjs
//
// Pure transform: derives the Firefox (Gecko) manifest from the single source
// manifest.json also used for the Chrome build. The Firefox manifest is never
// hand-maintained — scripts/build.mjs calls this at build time and
// scripts/build.mjs's assertions confirm the emitted file matches.
//
// Changes from the source manifest:
//   - `minimum_chrome_version` is removed (Chrome-specific key, meaningless to Firefox).
//   - `background.service_worker` becomes `background.scripts: [<file>]` (Firefox MV3
//     background pages/scripts, not service workers).
//   - `browser_specific_settings.gecko` is added with the add-on id, minimum Firefox
//     version, and a `data_collection_permissions` declaration.
// Everything else (permissions, action, icons, version, description, ...) is carried
// over unchanged.

const GECKO_ID = 'nodesnip@mentatweb'
const GECKO_STRICT_MIN_VERSION = '128.0'

export function buildFirefoxManifest(sourceManifest) {
  const { minimum_chrome_version, background, ...rest } = sourceManifest

  if (!background || typeof background.service_worker !== 'string') {
    throw new Error('Source manifest.json has no background.service_worker to translate.')
  }

  return {
    ...rest,
    background: {
      scripts: [background.service_worker],
    },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: GECKO_STRICT_MIN_VERSION,
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  }
}
