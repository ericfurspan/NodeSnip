// tests/firefox-manifest.test.js
import { describe, it, expect } from 'vitest'
import { buildFirefoxManifest } from '../scripts/firefox-manifest.mjs'

function sourceManifest() {
  return {
    manifest_version: 3,
    name: 'NodeSnip',
    version: '2.0.3',
    description: 'Capture any webpage element as a PNG.',
    homepage_url: 'https://github.com/ericfurspan/NodeSnip',
    minimum_chrome_version: '111',
    action: {
      default_icon: { 16: 'assets/icon16.png' },
      default_title: 'NodeSnip',
    },
    background: {
      service_worker: 'background.js',
    },
    permissions: ['activeTab', 'scripting', 'clipboardWrite'],
    icons: { 16: 'assets/icon16.png' },
  }
}

describe('buildFirefoxManifest', () => {
  it('removes minimum_chrome_version', () => {
    const manifest = buildFirefoxManifest(sourceManifest())
    expect(manifest).not.toHaveProperty('minimum_chrome_version')
  })

  it('replaces background.service_worker with background.scripts', () => {
    const manifest = buildFirefoxManifest(sourceManifest())
    expect(manifest.background).toEqual({ scripts: ['background.js'] })
    expect(manifest.background.service_worker).toBeUndefined()
  })

  it('adds browser_specific_settings.gecko with the add-on id, min version, and data collection permissions', () => {
    const manifest = buildFirefoxManifest(sourceManifest())
    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: 'nodesnip@mentatweb',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    })
  })

  it('carries over permissions, action, icons, and version unchanged', () => {
    const source = sourceManifest()
    const manifest = buildFirefoxManifest(source)
    expect(manifest.permissions).toEqual(source.permissions)
    expect(manifest.action).toEqual(source.action)
    expect(manifest.icons).toEqual(source.icons)
    expect(manifest.version).toBe(source.version)
    expect(manifest.manifest_version).toBe(3)
  })

  it('does not add host_permissions or content_scripts', () => {
    const manifest = buildFirefoxManifest(sourceManifest())
    expect(manifest).not.toHaveProperty('host_permissions')
    expect(manifest).not.toHaveProperty('content_scripts')
  })

  it('does not mutate the input manifest', () => {
    const source = sourceManifest()
    const snapshot = JSON.parse(JSON.stringify(source))
    buildFirefoxManifest(source)
    expect(source).toEqual(snapshot)
  })

  it('throws when the source manifest has no background.service_worker', () => {
    const source = sourceManifest()
    delete source.background.service_worker
    expect(() => buildFirefoxManifest(source)).toThrow()
  })
})
