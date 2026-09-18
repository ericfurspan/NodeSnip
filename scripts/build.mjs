// scripts/build.mjs
//
// Builds the extension entries (background, content) and copies the static assets
// into each target's output directory, then asserts that every emitted entry is a
// valid CLASSIC script and that each target's manifest is correct.
//
// Two targets share one source tree:
//   - chrome  → dist/          manifest.json copied byte-for-byte from source.
//   - firefox → dist-firefox/  manifest.json derived from source via
//                               scripts/firefox-manifest.mjs (never hand-maintained).
//
// Why the classic-script assertion: every NodeSnip entry is loaded as a classic
// script —
//   - content.js    — injected via chrome.scripting.executeScript (not an ES module)
//   - background.js — MV3 background (service worker on Chrome, scripts on Firefox),
//                      not declared as a module
// so an `import`/`export` statement in either is a fatal syntax error at load time.
// Vite 8's bundler (Rolldown) extracts code shared across entries into a chunk and
// rewrites the entries to `import` it, which is exactly what must not happen here.
// Nothing is shared between these two entries today (html2canvas is content-only),
// so no chunk is emitted — but that is a property of the current dependency graph,
// not a guarantee. assertClassicScripts() turns it into one: add a dependency both
// entries pull in and the build fails here rather than at extension load.

import { build } from 'vite'
import { Script } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  copyFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { sharedOutput } from '../vite.config.js'
import { buildFirefoxManifest } from './firefox-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
const targetArg = process.argv.find((a) => a.startsWith('--target='))
const requestedTarget = targetArg ? targetArg.slice('--target='.length) : null

const ENTRIES = {
  background: 'src/background.js',
  content: 'src/content.js',
}

const sourceManifestPath = resolve(root, 'manifest.json')
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))

// Each target's manifest.json is produced by `writeManifest`, which decides how:
// the Chrome manifest is copied byte-for-byte (so it stays provably identical to
// source), while the Firefox manifest is derived and serialized.
const TARGETS = {
  chrome: {
    outDir: 'dist',
    writeManifest: (outDir) => {
      copyFileSync(sourceManifestPath, resolve(root, `${outDir}/manifest.json`))
    },
    assertManifest: assertChromeManifest,
  },
  firefox: {
    outDir: 'dist-firefox',
    writeManifest: (outDir) => {
      const manifest = buildFirefoxManifest(sourceManifest)
      writeFileSync(resolve(root, `${outDir}/manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`)
    },
    assertManifest: assertFirefoxManifest,
  },
}

// In watch mode, keep dev behavior unchanged: a single target (chrome by default,
// or whichever --target was passed). Outside watch mode, `npm run build` builds
// every target unless --target narrows it (e.g. `build:firefox`).
const targetNames = requestedTarget
  ? [requestedTarget]
  : watch
    ? ['chrome']
    : Object.keys(TARGETS)

for (const name of targetNames) {
  if (!TARGETS[name]) throw new Error(`Unknown build target: ${name}`)
}

function runtimePackagesFromLock() {
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  return Object.entries(lock.packages)
    .filter(([path, metadata]) => path.startsWith('node_modules/') && metadata.dev !== true)
    .map(([path, metadata]) => ({
      path,
      name: path.slice('node_modules/'.length),
      version: metadata.version,
    }))
}

function writeThirdPartyNotices(outDir) {
  const sections = runtimePackagesFromLock().map(({ path, name, version }) => {
    const packageDir = resolve(root, path)
    const licenseFile = readdirSync(packageDir)
      .find(file => /^licen[cs]e(?:\..*)?$/i.test(file))
    if (!licenseFile) throw new Error(`No license file found for ${name} ${version}.`)
    const license = readFileSync(resolve(packageDir, licenseFile), 'utf8').trim()
    return `${name} ${version}\n\n${license}`
  })
  writeFileSync(
    resolve(root, `${outDir}/THIRD_PARTY_NOTICES.txt`),
    `NodeSnip third-party notices\n\n${sections.join('\n\n---\n\n')}\n`,
  )
}

// Copies the static (non-bundled) assets into the target's output directory. Runs
// via closeBundle so it also re-copies on every rebuild in watch mode.
function copyStaticAssets(outDir, writeManifest) {
  return {
    name: `copy-static-${outDir}`,
    closeBundle() {
      writeManifest(outDir)
      copyFileSync(resolve(root, 'LICENSE'), resolve(root, `${outDir}/LICENSE`))
      writeThirdPartyNotices(outDir)
      mkdirSync(resolve(root, `${outDir}/assets`), { recursive: true })
      cpSync(resolve(root, 'src/assets'), resolve(root, `${outDir}/assets`), { recursive: true })
    },
  }
}

// Compiles each entry the way the browser will load it. new Script() parses as a
// classic script without running it, so an `import`/`export` statement throws
// SyntaxError here instead of at extension load. Also fails if a shared chunk was
// emitted at all.
function assertClassicScripts(outDir) {
  const chunks = resolve(root, `${outDir}/chunks`)
  if (existsSync(chunks)) {
    throw new Error(`Build emitted ${outDir}/chunks/ — entries would import from it; classic scripts cannot.`)
  }
  for (const name of Object.keys(ENTRIES)) {
    const file = resolve(root, `${outDir}/${name}.js`)
    try {
      new Script(readFileSync(file, 'utf8'), { filename: file })
    } catch (err) {
      throw new Error(`${outDir}/${name}.js is not a valid classic script: ${err.message}`)
    }
  }
  console.log(`✓ classic-script check passed (${outDir}: ${Object.keys(ENTRIES).join(', ')})`)
}

// Every production dependency is bundled into content.js, so its license notice
// must ship in each target's upload package. The notice file is generated from the
// lockfile and installed license files; this confirms every package and version
// made it in.
function assertThirdPartyNotices(outDir) {
  const notices = readFileSync(resolve(root, `${outDir}/THIRD_PARTY_NOTICES.txt`), 'utf8')
  const runtimePackages = runtimePackagesFromLock()
    .map(({ name, version }) => `${name} ${version}`)

  for (const packageAndVersion of runtimePackages) {
    if (!notices.includes(packageAndVersion)) {
      throw new Error(`${outDir}/THIRD_PARTY_NOTICES.txt is missing ${packageAndVersion}.`)
    }
  }
  console.log(`✓ third-party notice check passed (${outDir}: ${runtimePackages.length} packages)`)
}

function assertChromeManifest(outDir) {
  const emitted = readFileSync(resolve(root, `${outDir}/manifest.json`), 'utf8')
  const source = readFileSync(sourceManifestPath, 'utf8')
  if (emitted !== source) {
    throw new Error(`${outDir}/manifest.json is not byte-identical to source manifest.json.`)
  }
  console.log(`✓ manifest check passed (${outDir}: byte-identical to source manifest.json)`)
}

function assertFirefoxManifest(outDir) {
  const manifest = JSON.parse(readFileSync(resolve(root, `${outDir}/manifest.json`), 'utf8'))
  const gecko = manifest.browser_specific_settings?.gecko

  if (!gecko || gecko.id !== 'nodesnip@mentatweb') {
    throw new Error(`${outDir}/manifest.json is missing the expected browser_specific_settings.gecko.id.`)
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    throw new Error(`${outDir}/manifest.json is missing background.scripts.`)
  }
  if (manifest.background?.service_worker) {
    throw new Error(`${outDir}/manifest.json must not declare background.service_worker.`)
  }
  if ('minimum_chrome_version' in manifest) {
    throw new Error(`${outDir}/manifest.json must not carry minimum_chrome_version.`)
  }
  console.log(`✓ manifest check passed (${outDir}: gecko id present, background.scripts present, no service_worker/minimum_chrome_version)`)
}

async function buildTarget(name) {
  const { outDir, writeManifest, assertManifest } = TARGETS[name]

  rmSync(resolve(root, outDir), { recursive: true, force: true })

  await build({
    root,
    configFile: false, // build options live here, not in vite.config.js
    plugins: [copyStaticAssets(outDir, writeManifest)],
    // Selects the capture path in src/capture.js (via src/target.js) for this
    // target: 'chrome' keeps html2canvas, 'firefox' switches to native
    // chrome.tabs.captureTab. vite.config.js's own default ('chrome') only
    // covers `vite dev` and Vitest, which don't go through this build.
    define: {
      __NODESNIP_TARGET__: JSON.stringify(name),
    },
    build: {
      outDir,
      sourcemap: false,
      rollupOptions: {
        input: Object.fromEntries(
          Object.entries(ENTRIES).map(([entryName, input]) => [entryName, resolve(root, input)]),
        ),
        output: sharedOutput,
      },
      watch: watch ? {} : null,
    },
  })

  if (!watch) {
    assertClassicScripts(outDir)
    assertThirdPartyNotices(outDir)
    assertManifest(outDir)
  }
}

for (const name of targetNames) {
  await buildTarget(name)
}
