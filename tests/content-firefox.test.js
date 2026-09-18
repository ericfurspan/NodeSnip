// tests/content-firefox.test.js
//
// The Firefox-target ordering in content.js's runCaptureAction: no NodeSnip UI
// (reticle, dialog, banner, spinner) may be present when the native-capture
// captureRect message is sent, since — unlike html2canvas — chrome.tabs.captureTab
// screenshots the real rendered page. Stubs src/target.js the same way
// tests/capture-firefox.test.js does; the ordering itself lives in content.js
// (see AGENTS.md and issue #21).

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/target.js', () => ({ TARGET: 'firefox' }))

// jsdom has no rendering pipeline and does not implement requestAnimationFrame
// (confirmed absent in this project's jsdom version) — stub it so the two-frame
// wait before native capture resolves instead of hanging the test.
beforeEach(() => {
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0)
})

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function freshChrome(onCaptureRect) {
  return {
    runtime: {
      sendMessage: vi.fn((msg) => {
        if (msg.action === 'captureRect') {
          onCaptureRect?.()
          return Promise.resolve({ ok: true, dataUrl: PNG_DATA_URL })
        }
        return undefined
      }),
      onMessage: { addListener: vi.fn() },
    },
  }
}

async function clickThroughToDialog(action) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const overlay = document.getElementById('nodesnip-overlay')
  vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, width: 100, height: 100 })

  overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }))
  overlay.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }))
  document.getElementById(action === 'Copy' ? 'ns-btn-copy' : 'ns-btn-download').click()
}

describe('content (firefox target): no NodeSnip UI in the native screenshot', () => {
  beforeEach(async () => {
    document.body.innerHTML = ''
    delete window.__nodeSnipInjected
    global.ClipboardItem = class { constructor(data) { this.data = data } }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('has removed every NodeSnip-owned node by the time the captureRect message is sent', async () => {
    let ownedNodeCountAtCapture = null
    global.chrome = freshChrome(() => {
      ownedNodeCountAtCapture = document.querySelectorAll('[data-nodesnip]').length
    })
    vi.resetModules()
    await import('../src/content.js')

    await clickThroughToDialog('Copy')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(ownedNodeCountAtCapture).toBe(0)
  })

  it('has not shown the spinner yet when the captureRect message is sent', async () => {
    let spinnerPresentAtCapture = null
    global.chrome = freshChrome(() => {
      spinnerPresentAtCapture = document.getElementById('nodesnip-spinner') !== null
    })
    vi.resetModules()
    await import('../src/content.js')

    await clickThroughToDialog('Copy')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(spinnerPresentAtCapture).toBe(false)
  })

  it('shows the spinner while the destination (clipboard write) runs, after the screenshot is taken', async () => {
    global.chrome = freshChrome()
    vi.resetModules()
    await import('../src/content.js')

    let spinnerPresentDuringSink = null
    navigator.clipboard.write.mockImplementation(async () => {
      spinnerPresentDuringSink = document.getElementById('nodesnip-spinner') !== null
    })

    await clickThroughToDialog('Copy')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(spinnerPresentDuringSink).toBe(true)
  })

  it('removes the spinner once the action completes', async () => {
    global.chrome = freshChrome()
    vi.resetModules()
    await import('../src/content.js')

    await clickThroughToDialog('Download')
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(document.getElementById('nodesnip-spinner')).toBeNull()
    expect(anchorClick).toHaveBeenCalled()
  })
})
