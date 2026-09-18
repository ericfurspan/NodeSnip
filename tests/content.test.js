// tests/content.test.js
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('html2canvas', () => ({
  default: vi.fn().mockResolvedValue({
    toDataURL: vi.fn(() => 'data:image/png;base64,fake'),
    toBlob: vi.fn((callback) => callback(new Blob(['png'], { type: 'image/png' }))),
  }),
}))

function freshChrome() {
  return {
    runtime: {
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
  }
}

describe('content: picker activation', () => {
  beforeEach(async () => {
    document.body.innerHTML = ''
    delete window.__nodeSnipInjected
    global.chrome = freshChrome()
    vi.resetModules()
    await import('../src/content.js')
  })

  it('creates overlay element', () => {
    expect(document.getElementById('nodesnip-overlay')).not.toBeNull()
  })

  it('creates highlight element with pointer-events none', () => {
    const el = document.getElementById('nodesnip-highlight')
    expect(el).not.toBeNull()
    expect(el.style.pointerEvents).toBe('none')
  })

  it('creates banner with instruction text', () => {
    const el = document.getElementById('nodesnip-banner')
    expect(el).not.toBeNull()
    expect(el.textContent).toContain('NodeSnip')
    expect(el.textContent).toContain('Esc')
  })

  it('does not double-initialise on re-injection', async () => {
    // window.__nodeSnipInjected is now set; re-import should be a no-op
    vi.resetModules()
    await import('../src/content.js')
    expect(document.querySelectorAll('#nodesnip-overlay').length).toBe(1)
  })

  it('reactivates picker when activate message is received', async () => {
    // Simulate capture cleanup — remove picker elements
    document.getElementById('nodesnip-overlay')?.remove()
    document.getElementById('nodesnip-highlight')?.remove()
    document.getElementById('nodesnip-reticle')?.remove()
    document.getElementById('nodesnip-banner')?.remove()

    // Grab the message listener registered in beforeEach
    const [messageListener] = chrome.runtime.onMessage.addListener.mock.calls[0]
    messageListener({ action: 'activate' })

    expect(document.getElementById('nodesnip-overlay')).not.toBeNull()
  })
})

describe('content: element detection', () => {
  beforeEach(async () => {
    document.body.innerHTML = ''
    delete window.__nodeSnipInjected
    global.chrome = freshChrome()
    vi.resetModules()
    await import('../src/content.js')
  })

  it('updates reticle position on mousemove over a page element', () => {
    const target = document.createElement('div')
    target.id = 'page-target'
    document.body.appendChild(target)

    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      { top: 10, left: 20, width: 150, height: 60 },
    )

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 30 }))

    const highlight = document.getElementById('nodesnip-highlight')
    expect(highlight.style.display).toBe('block')
    expect(highlight.style.top).toBe('10px')
    expect(highlight.style.left).toBe('20px')
    expect(highlight.style.width).toBe('150px')
    expect(highlight.style.height).toBe('60px')
  })

  it('hides reticle when hovering overlay itself', () => {
    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay])

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }))

    expect(document.getElementById('nodesnip-highlight').style.display).toBe('none')
  })

  it('can select a page element that uses the NodeSnip marker attribute', () => {
    const target = document.createElement('div')
    target.setAttribute('data-nodesnip', 'page-owned')
    document.body.appendChild(target)

    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      { top: 10, left: 20, width: 150, height: 60 },
    )

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 30 }))

    expect(document.getElementById('nodesnip-highlight').style.display).toBe('block')
  })
})

describe('content: Escape cancellation', () => {
  beforeEach(async () => {
    document.body.innerHTML = ''
    delete window.__nodeSnipInjected
    global.chrome = freshChrome()
    vi.resetModules()
    await import('../src/content.js')
  })

  it('removes all picker elements on Escape', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.getElementById('nodesnip-overlay')).toBeNull()
    expect(document.getElementById('nodesnip-reticle')).toBeNull()
    expect(document.getElementById('nodesnip-banner')).toBeNull()
  })

  it('sends pickerCancelled message on Escape', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'pickerCancelled' })
  })

  it('removes only NodeSnip nodes when the page owns the same IDs', () => {
    const ids = [
      'nodesnip-overlay',
      'nodesnip-highlight',
      'nodesnip-reticle',
      'nodesnip-banner',
    ]
    const pageNodes = ids.map((id) => {
      const el = document.createElement('div')
      el.id = id
      el.dataset.pageOwned = 'true'
      document.body.prepend(el)
      return el
    })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(document.querySelectorAll('[data-nodesnip]').length).toBe(0)
    for (const el of pageNodes) expect(el.isConnected).toBe(true)
  })
})

describe('content: full-render capture (click)', () => {
  let mockHtml2canvas

  beforeEach(async () => {
    document.body.innerHTML = ''
    delete window.__nodeSnipInjected
    global.chrome = freshChrome()
    global.ClipboardItem = class { constructor(data) { this.data = data } }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn().mockResolvedValue(undefined) },
    })
    vi.resetModules()
    const h2c = await import('html2canvas')
    mockHtml2canvas = h2c.default
    mockHtml2canvas.mockClear()

    await import('../src/content.js')
  })

  it('shows action dialog on element click, then captures and downloads on PNG', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)

    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      { top: 0, left: 0, width: 100, height: 100 },
    )

    // Hover to set currentTarget, then click to show dialog
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }))
    overlay.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, shiftKey: false }))

    // Dialog should now be present, offering both actions
    expect(document.getElementById('nodesnip-dialog')).not.toBeNull()
    expect(document.getElementById('ns-btn-copy')).not.toBeNull()
    expect(document.getElementById('ns-btn-download')).not.toBeNull()

    // Anchor clicks trigger a jsdom "not implemented: navigation" noise otherwise
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    document.getElementById('ns-btn-download').click()
    await new Promise((r) => setTimeout(r, 0))

    // The dialog action reaches capture with the picked element; what capture does
    // with it (options, clone guards, blob conversion) is tests/capture.test.js
    expect(mockHtml2canvas).toHaveBeenCalledWith(target, expect.any(Object))
    expect(anchorClick).toHaveBeenCalledOnce()
    expect(anchorClick.mock.instances[0].download).toMatch(/\.png$/)
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'pickerCancelled' })
  })

  it('writes the rendered PNG to the clipboard on Copy', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      { top: 0, left: 0, width: 100, height: 100 },
    )

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }))
    overlay.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }))
    document.getElementById('ns-btn-copy').click()
    await new Promise((r) => setTimeout(r, 0))

    expect(navigator.clipboard.write).toHaveBeenCalledOnce()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'pickerCancelled' })
  })

  it('shows a clipboard-specific error when Chrome rejects Copy', async () => {
    navigator.clipboard.write.mockRejectedValueOnce(new Error('NotAllowedError'))
    const target = document.createElement('div')
    document.body.appendChild(target)
    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      { top: 0, left: 0, width: 100, height: 100 },
    )

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }))
    overlay.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }))
    document.getElementById('ns-btn-copy').click()
    await new Promise((r) => setTimeout(r, 0))

    expect(document.getElementById('nodesnip-error').textContent).toContain(
      'Chrome could not write the image to your clipboard',
    )
  })

  it('starts only one capture when an action button is clicked repeatedly', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      { top: 0, left: 0, width: 100, height: 100 },
    )

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }))
    overlay.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }))
    const button = document.getElementById('ns-btn-copy')
    button.click()
    button.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(mockHtml2canvas).toHaveBeenCalledTimes(1)
  })
})

describe('content: Shift-to-lock', () => {
  let overlay, target, mockH2c

  beforeEach(async () => {
    document.body.innerHTML = ''
    delete window.__nodeSnipInjected
    global.chrome = freshChrome()
    vi.resetModules()
    const h2cMod = await import('html2canvas')
    mockH2c = h2cMod.default
    await import('../src/content.js')

    target = document.createElement('div')
    document.body.appendChild(target)
    overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 10, left: 20, width: 100, height: 50 })
    // Establish currentTarget by hovering
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 30 }))
  })

  it('ignores mousemove while Shift is held', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    const other = document.createElement('div')
    document.body.appendChild(other)
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, other])
    vi.spyOn(other, 'getBoundingClientRect').mockReturnValue({ top: 200, left: 200, width: 50, height: 50 })
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 250 }))
    const reticle = document.getElementById('nodesnip-reticle')
    // Position unchanged — still the original frozen target
    expect(reticle.style.top).toBe('10px')
    expect(reticle.style.left).toBe('20px')
  })

  it('does not freeze when Shift is pressed with no hovered target', () => {
    // Clear currentTarget by moving mouse off all elements
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay])
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    // Hover a new element — highlight should update normally (not frozen)
    const fresh = document.createElement('div')
    document.body.appendChild(fresh)
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, fresh])
    vi.spyOn(fresh, 'getBoundingClientRect').mockReturnValue({ top: 99, left: 99, width: 50, height: 50 })
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }))
    expect(document.getElementById('nodesnip-highlight').style.top).toBe('99px')
  })

  it('resumes normal hover after Shift is released', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    const other = document.createElement('div')
    document.body.appendChild(other)
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, other])
    vi.spyOn(other, 'getBoundingClientRect').mockReturnValue({ top: 300, left: 300, width: 80, height: 40 })
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 300 }))
    expect(document.getElementById('nodesnip-highlight').style.top).toBe('300px')
  })

  it('captures the frozen element (not the hovered one) when a dialog action is clicked while Shift is held', async () => {
    global.ClipboardItem = class { constructor(data) { this.data = data } }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn().mockResolvedValue(undefined) },
    })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    // Mouse moves to a different element while frozen
    const other = document.createElement('div')
    document.body.appendChild(other)
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, other])
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 250 }))
    // Click — shows action dialog with the frozen (original) target
    overlay.dispatchEvent(new MouseEvent('click', { clientX: 250, clientY: 250, shiftKey: true }))
    expect(document.getElementById('nodesnip-dialog')).not.toBeNull()
    // Copy should capture the original frozen target, not other
    document.getElementById('ns-btn-copy').click()
    await new Promise((r) => setTimeout(r, 0))
    expect(mockH2c).toHaveBeenCalledWith(target, expect.any(Object))
    expect(navigator.clipboard.write).toHaveBeenCalledOnce()
  })

  it('updates the banner to indicate locked state when frozen', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    expect(document.getElementById('nodesnip-banner').textContent).toContain('locked')
  })

  it('restores the normal banner when Shift is released', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    const banner = document.getElementById('nodesnip-banner')
    expect(banner.textContent).toContain('NodeSnip')
    expect(banner.textContent).not.toContain('locked')
  })
})

describe('content: capture error handling', () => {
  // Helper: set up content script with html2canvas mocked to reject
  async function setupWithFailingCapture() {
    document.body.innerHTML = ''
    delete window.__nodeSnipInjected
    global.chrome = freshChrome()

    vi.resetModules()
    const h2c = await import('html2canvas')
    h2c.default.mockRejectedValue(new Error('CSP violation: toIFrame blocked'))

    await import('../src/content.js')

    // Set up a hoverable target so onClick has a currentTarget
    const target = document.createElement('div')
    document.body.appendChild(target)
    const overlay = document.getElementById('nodesnip-overlay')
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([overlay, target])
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, width: 100, height: 100 })
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }))
    overlay.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }))
    // Click shows the action dialog; trigger capture via PNG
    document.getElementById('ns-btn-download').click()

    await new Promise((r) => setTimeout(r, 0))
  }

  it('shows an error toast when html2canvas throws', async () => {
    await setupWithFailingCapture()
    const toast = document.getElementById('nodesnip-error')
    expect(toast).not.toBeNull()
    expect(toast.textContent).toContain('Download failed')
  })

  it('sends pickerCancelled to clear the badge when html2canvas throws', async () => {
    await setupWithFailingCapture()
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'pickerCancelled' })
  })

  it('removes the spinner even when html2canvas throws', async () => {
    await setupWithFailingCapture()
    expect(document.getElementById('nodesnip-spinner')).toBeNull()
  })
})
