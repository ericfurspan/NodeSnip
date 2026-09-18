// tests/capture-firefox.test.js
//
// The Firefox capture path in src/capture.js (TARGET === 'firefox'): page-relative
// rect computation, the captureRect runtime message, and PNG data URL → Blob
// conversion. Stubs src/target.js rather than running the Firefox build, so this
// exercises the same source the Firefox build ships — chosen here by an ordinary
// vi.mock instead of scripts/build.mjs's per-target __NODESNIP_TARGET__ define.
//
// The Chrome/html2canvas path is covered separately in tests/capture.test.js,
// which keeps the default ('chrome') target from vite.config.js.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('../src/target.js', () => ({ TARGET: 'firefox' }))

import { captureElement } from '../src/capture.js'

// A real 1x1 transparent PNG, so atob/Blob decoding has genuine bytes to work with.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('captureElement: firefox target (native chrome.tabs.captureTab)', () => {
  let target

  beforeEach(() => {
    document.body.innerHTML = ''
    target = document.createElement('div')
    document.body.appendChild(target)
    global.chrome = { runtime: { sendMessage: vi.fn() } }
  })

  // The cross-origin iframe test below poisons its element's contentWindow
  // getter to throw; left in the DOM, jsdom's own window-close teardown walk at
  // the end of the file trips over it as an unhandled error. Clearing the body
  // after each test removes it well before that.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sends a captureRect message with a page-relative rect (viewport rect plus scroll) and devicePixelRatio scale', async () => {
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 40, left: 30, width: 100, height: 60 })
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(10)
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(20)
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true, dataUrl: PNG_DATA_URL })

    await captureElement(target)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'captureRect',
      rect: { x: 40, y: 60, width: 100, height: 60 },
      scale: 2,
    })
  })

  it('falls back to scale 1 when devicePixelRatio is unavailable', async () => {
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, width: 10, height: 10 })
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(0)
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true, dataUrl: PNG_DATA_URL })

    await captureElement(target)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ scale: 1 }))
  })

  it('resolves to a PNG blob decoded from the returned data URL', async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true, dataUrl: PNG_DATA_URL })

    const blob = await captureElement(target)

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBeGreaterThan(0)
  })

  it('rejects with the background script\'s error when the response is not ok', async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: false, error: 'Native tab capture failed.' })
    await expect(captureElement(target)).rejects.toThrow('Native tab capture failed.')
  })

  it('rejects with a generic message when a failed response carries no error text', async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: false })
    await expect(captureElement(target)).rejects.toThrow('Native capture failed.')
  })

  it('propagates a rejected sendMessage (e.g. extension context invalidated)', async () => {
    chrome.runtime.sendMessage.mockRejectedValue(new Error('Extension context invalidated.'))
    await expect(captureElement(target)).rejects.toThrow('Extension context invalidated.')
  })

  it('still rejects a detached element before sending any message', async () => {
    target.remove()
    await expect(captureElement(target)).rejects.toMatchObject({ expected: true })
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })

  // A native screenshot doesn't actually need this rejection — unlike
  // html2canvas, tabs.captureTab could in principle capture cross-origin iframe
  // content correctly. It rejects here only because decision 2 keeps captureElement's
  // pre-flight checks shared across both targets; this locks in that shared,
  // deliberately conservative behavior, not a capability limit of the native path.
  it('still rejects a cross-origin iframe before sending any message', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    Object.defineProperty(iframe, 'contentWindow', {
      get() { throw new Error('Blocked a frame with origin') },
    })

    await expect(captureElement(iframe)).rejects.toMatchObject({ expected: true })
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })
})
