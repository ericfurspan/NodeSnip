import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

function makeChrome({ sendMessageRejects = true, captureTab } = {}) {
  return {
    action: {
      onClicked: { addListener: vi.fn((fn) => { globalThis._onClickedCb = fn }) },
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
    runtime: {
      id: 'fakeextid',
      onMessage: { addListener: vi.fn((fn) => { globalThis._onMessageCb = fn }) },
    },
    tabs: {
      sendMessage: sendMessageRejects
        ? vi.fn().mockRejectedValue(new Error('no listener'))
        : vi.fn().mockResolvedValue(undefined),
      captureTab: captureTab ?? vi.fn().mockResolvedValue('data:image/png;base64,fake'),
    },
  }
}

describe('background: icon click — first injection', () => {
  beforeEach(async () => {
    vi.resetModules()
    globalThis._onClickedCb = null
    globalThis._onMessageCb = null
    global.chrome = makeChrome({ sendMessageRejects: true })
    await import('../src/background.js')
  })

  it('registers onClicked listener', () => {
    expect(chrome.action.onClicked.addListener).toHaveBeenCalled()
  })

  it('tries sendMessage before executeScript', async () => {
    await globalThis._onClickedCb({ id: 42 })
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { action: 'activate' })
  })

  it('injects content.js when sendMessage fails (no content script)', async () => {
    await globalThis._onClickedCb({ id: 42 })
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ['content.js'],
    })
  })

  it('sets active badge after injection', async () => {
    await globalThis._onClickedCb({ id: 42 })
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '●', tabId: 42 })
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#3b82f6',
      tabId: 42,
    })
  })
})

describe('background: icon click — reactivation via sendMessage', () => {
  beforeEach(async () => {
    vi.resetModules()
    globalThis._onClickedCb = null
    global.chrome = makeChrome({ sendMessageRejects: false })
    await import('../src/background.js')
  })

  it('does not call executeScript when sendMessage succeeds', async () => {
    await globalThis._onClickedCb({ id: 42 })
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { action: 'activate' })
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('still sets the badge when reactivating', async () => {
    await globalThis._onClickedCb({ id: 42 })
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '●', tabId: 42 })
  })
})

describe('background: messages', () => {
  beforeEach(async () => {
    vi.resetModules()
    globalThis._onMessageCb = null
    global.chrome = makeChrome({ sendMessageRejects: true })
    await import('../src/background.js')
  })

  it('clears badge on pickerCancelled', () => {
    globalThis._onMessageCb({ action: 'pickerCancelled' }, { id: 'fakeextid', tab: { id: 42 } })
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '', tabId: 42 })
  })

  it('does not throw when setBadgeText fails on pickerCancelled', () => {
    chrome.action.setBadgeText = vi.fn().mockImplementation(() => { throw new Error('tab closed') })
    expect(() =>
      globalThis._onMessageCb({ action: 'pickerCancelled' }, { id: 'fakeextid', tab: { id: 42 } }),
    ).not.toThrow()
  })

  // Driven through pickerCancelled — the only handled message. The identical call
  // with sender.id === 'fakeextid' clears the badge (see the first test in this
  // group), so a no-op here is the sender check doing its job, not a dead path.
  it('ignores messages whose sender.id does not match the extension id', () => {
    globalThis._onMessageCb({ action: 'pickerCancelled' }, { id: 'other-extension', tab: { id: 42 } })
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
  })

  it('ignores messages with no sender.id', () => {
    globalThis._onMessageCb({ action: 'pickerCancelled' }, { tab: { id: 42 } })
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
  })
})

describe('background: icon click — badge failure resilience', () => {
  beforeEach(async () => {
    vi.resetModules()
    globalThis._onClickedCb = null
    global.chrome = makeChrome({ sendMessageRejects: false })
    await import('../src/background.js')
  })

  it('does not throw when setBadgeText fails after successful activation', async () => {
    chrome.action.setBadgeText = vi.fn().mockImplementation(() => { throw new Error('tab closed') })
    await expect(globalThis._onClickedCb({ id: 42 })).resolves.not.toThrow()
  })
})

// captureRect is the Firefox-target message from src/capture.js's native
// capture path: the background script is the only place privileged enough to
// call chrome.tabs.captureTab, so it validates and clamps everything the
// content script sends before acting on it.
describe('background: captureRect (Firefox native capture)', () => {
  const validRect = { x: 10, y: 20, width: 100, height: 50 }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  beforeEach(async () => {
    vi.resetModules()
    globalThis._onMessageCb = null
    delete global.browser
    global.chrome = makeChrome({ sendMessageRejects: true })
    await import('../src/background.js')
  })

  afterEach(() => {
    delete global.browser
  })

  it('rejects a message whose sender.id does not match the extension id', async () => {
    const sendResponse = vi.fn()
    const result = globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1 },
      { id: 'other-extension', tab: { id: 7 } },
      sendResponse,
    )
    expect(result).toBeUndefined()
    await settle()
    expect(chrome.tabs.captureTab).not.toHaveBeenCalled()
    expect(sendResponse).not.toHaveBeenCalled()
  })

  it('rejects a message with no sender.tab', async () => {
    const sendResponse = vi.fn()
    const result = globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1 },
      { id: 'fakeextid' },
      sendResponse,
    )
    expect(result).toBeUndefined()
    await settle()
    expect(chrome.tabs.captureTab).not.toHaveBeenCalled()
    expect(sendResponse).not.toHaveBeenCalled()
  })

  it.each([
    ['missing rect', undefined],
    ['non-object rect', 'nope'],
    ['negative x', { x: -1, y: 0, width: 10, height: 10 }],
    ['negative y', { x: 0, y: -1, width: 10, height: 10 }],
    ['zero width', { x: 0, y: 0, width: 0, height: 10 }],
    ['zero height', { x: 0, y: 0, width: 10, height: 0 }],
    ['non-finite width', { x: 0, y: 0, width: Infinity, height: 10 }],
    ['NaN height', { x: 0, y: 0, width: 10, height: NaN }],
    ['width over the 32767 bound', { x: 0, y: 0, width: 32768, height: 10 }],
    ['x over the 32767 bound', { x: 32768, y: 0, width: 10, height: 10 }],
  ])('rejects an invalid rect (%s) without calling captureTab', async (_label, rect) => {
    const sendResponse = vi.fn()
    const result = globalThis._onMessageCb(
      { action: 'captureRect', rect, scale: 1 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    expect(result).toBe(true)
    await settle()
    expect(chrome.tabs.captureTab).not.toHaveBeenCalled()
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: expect.any(String) })
  })

  it('replies naming both namespaces when neither browser.tabs.captureTab nor chrome.tabs.captureTab exists', async () => {
    delete chrome.tabs.captureTab
    const sendResponse = vi.fn()
    globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringContaining('browser.tabs.captureTab'),
    })
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringContaining('chrome.tabs.captureTab'),
    })
  })

  // Firefox implements captureTab only on the `browser` global — the `chrome`
  // alias it also exposes does not carry this Firefox-only API — so the
  // background script must prefer `browser` when it is present.
  it('prefers browser.tabs.captureTab over chrome.tabs.captureTab when both exist', async () => {
    const browserCaptureTab = vi.fn().mockResolvedValue('data:image/png;base64,frombrowser')
    global.browser = { tabs: { captureTab: browserCaptureTab } }
    const sendResponse = vi.fn()

    globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()

    expect(browserCaptureTab).toHaveBeenCalledWith(7, {
      format: 'png',
      rect: validRect,
      scale: 1,
    })
    expect(chrome.tabs.captureTab).not.toHaveBeenCalled()
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, dataUrl: 'data:image/png;base64,frombrowser' })
  })

  it('falls back to chrome.tabs.captureTab when the browser global has no tabs.captureTab', async () => {
    // A `browser` global with no captureTab (e.g. Chrome's own webextension-polyfill
    // shims, or a `browser` object that just doesn't have this API) must not be
    // mistaken for Firefox's capture-capable one.
    global.browser = { tabs: {} }
    const sendResponse = vi.fn()

    globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()

    expect(chrome.tabs.captureTab).toHaveBeenCalledWith(7, expect.any(Object))
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, dataUrl: 'data:image/png;base64,fake' })
  })

  it('names the browser namespace in the error text when browser.tabs.captureTab itself rejects', async () => {
    global.browser = { tabs: { captureTab: vi.fn().mockRejectedValue(new Error('denied')) } }
    const sendResponse = vi.fn()
    globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'browser.tabs.captureTab failed: denied' })
  })

  it('calls captureTab with the sender tab id and the validated rect, and replies asynchronously', async () => {
    const sendResponse = vi.fn()
    const result = globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 2 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )

    // Async: the listener returns true and has not replied yet.
    expect(result).toBe(true)
    expect(sendResponse).not.toHaveBeenCalled()

    await settle()

    expect(chrome.tabs.captureTab).toHaveBeenCalledWith(7, {
      format: 'png',
      rect: validRect,
      scale: 2,
    })
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, dataUrl: 'data:image/png;base64,fake' })
  })

  it('never captures a tab other than the sender\'s, regardless of what the message carries', async () => {
    const sendResponse = vi.fn()
    globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1, tabId: 999 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()
    expect(chrome.tabs.captureTab).toHaveBeenCalledWith(7, expect.any(Object))
  })

  it.each([
    [0, 1],
    [-3, 1],
    [NaN, 1],
    [undefined, 1],
    [4, 4],
    [4.5, 4],
    [100, 4],
  ])('clamps scale %s to %s (the (0, 4] bound)', async (input, expected) => {
    const sendResponse = vi.fn()
    globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: input },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()
    expect(chrome.tabs.captureTab).toHaveBeenCalledWith(7, expect.objectContaining({ scale: expected }))
  })

  it('names the chrome namespace in the error text when chrome.tabs.captureTab rejects', async () => {
    global.chrome.tabs.captureTab = vi.fn().mockRejectedValue(new Error('permission denied'))
    const sendResponse = vi.fn()
    globalThis._onMessageCb(
      { action: 'captureRect', rect: validRect, scale: 1 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: 'chrome.tabs.captureTab failed: permission denied',
    })
  })

  // handleCaptureRect resolves every case it knows about to { ok: false, ... }
  // rather than rejecting, so nothing in normal use hits this path. It still
  // exists so a content script's sendMessage promise can never hang forever —
  // forced here via a rect whose own property access throws.
  it('still replies (rather than leaving the content script hanging) if handleCaptureRect itself throws', async () => {
    const sendResponse = vi.fn()
    const poisonedRect = {
      get x() { throw new Error('boom') },
      y: 0, width: 10, height: 10,
    }
    globalThis._onMessageCb(
      { action: 'captureRect', rect: poisonedRect, scale: 1 },
      { id: 'fakeextid', tab: { id: 7 } },
      sendResponse,
    )
    await settle()
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'boom' })
  })
})
