chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'activate' })
  } catch {
    // Content script not yet injected — inject it (first click, or after page reload)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      })
    } catch {
      // Cannot inject into this tab (chrome://, extension pages, etc.) — bail out silently
      return
    }
  }
  try {
    chrome.action.setBadgeText({ text: '●', tabId: tab.id })
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6', tabId: tab.id })
  } catch {
    // Tab may have closed between click and badge update
  }
})

// Bounds a captureRect request. 32767 matches the largest single canvas
// dimension most engines allow; a request past it, or a non-finite/negative one,
// is a defect (in NodeSnip or in the page) rather than a real capture to attempt.
const MAX_RECT_DIMENSION = 32767
const MAX_SCALE = 4

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

function isValidCaptureRect(rect) {
  if (!rect || typeof rect !== 'object') return false
  const { x, y, width, height } = rect
  return (
    isFiniteNumber(x) && x >= 0 && x <= MAX_RECT_DIMENSION &&
    isFiniteNumber(y) && y >= 0 && y <= MAX_RECT_DIMENSION &&
    isFiniteNumber(width) && width > 0 && width <= MAX_RECT_DIMENSION &&
    isFiniteNumber(height) && height > 0 && height <= MAX_RECT_DIMENSION
  )
}

// Clamps to (0, MAX_SCALE]: a non-finite or non-positive value falls back to 1
// (devicePixelRatio's own common default) instead of being rejected outright;
// anything above the ceiling is capped rather than passed straight to the OS.
function clampScale(scale) {
  if (!isFiniteNumber(scale) || scale <= 0) return 1
  return Math.min(scale, MAX_SCALE)
}

// Firefox implements captureTab (like most Promise-based extension APIs) only
// on the `browser` global, not on the `chrome` alias it also provides for
// Chrome-extension compatibility — chrome.tabs.captureTab is undefined there.
// Chrome only has `chrome`. Check `browser` first and fall back to `chrome`,
// resolved fresh on every call (not cached at module load) so a namespace that
// appears or disappears between calls is picked up, and so tests can vary
// either independently. Returns null when neither exposes the API.
function resolveCaptureTab() {
  const browserNs = globalThis.browser
  if (typeof browserNs?.tabs?.captureTab === 'function') {
    return { namespace: 'browser', fn: (...args) => browserNs.tabs.captureTab(...args) }
  }
  if (typeof chrome.tabs?.captureTab === 'function') {
    return { namespace: 'chrome', fn: (...args) => chrome.tabs.captureTab(...args) }
  }
  return null
}

// Handles a captureRect request from src/capture.js's Firefox target — the
// caller (chrome.runtime.onMessage below) has already checked sender.id and
// that sender.tab exists. Always captures tabId, the requesting tab; the
// message itself carries no tab identifier, so there is nothing else it could
// capture.
async function handleCaptureRect(message, tabId) {
  if (!isValidCaptureRect(message?.rect)) {
    return { ok: false, error: 'Invalid capture rect.' }
  }
  const captureTab = resolveCaptureTab()
  if (!captureTab) {
    return {
      ok: false,
      error: 'Native tab capture is not available: neither browser.tabs.captureTab nor chrome.tabs.captureTab exists.',
    }
  }
  try {
    const dataUrl = await captureTab.fn(tabId, {
      format: 'png',
      rect: message.rect,
      scale: clampScale(message.scale),
    })
    return { ok: true, dataUrl }
  } catch (err) {
    // Names which namespace's captureTab failed, so a future failure shows
    // which lookup was actually used.
    return { ok: false, error: `${captureTab.namespace}.tabs.captureTab failed: ${err?.message || 'unknown error'}` }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Reject any message whose sender isn't this extension. Legitimate runtime
  // messages from our own content scripts and extension pages always carry
  // sender.id === chrome.runtime.id, so a missing or mismatched id means the
  // message did not originate from us — drop it.
  if (sender.id !== chrome.runtime.id) return

  const tabId = sender.tab?.id

  if (message.action === 'pickerCancelled') {
    try { chrome.action.setBadgeText({ text: '', tabId }) } catch {}
    return
  }

  if (message.action === 'captureRect') {
    // Firefox target only (src/capture.js). No sender tab means no tab to
    // capture and no one to reply to.
    if (!tabId) return
    // handleCaptureRect resolves its own failures to { ok: false, ... } and
    // shouldn't reject, but the fallback still replies rather than leaving the
    // content script's sendMessage promise unsettled if it ever does.
    handleCaptureRect(message, tabId).then(
      sendResponse,
      (err) => sendResponse({ ok: false, error: err?.message || 'Native tab capture failed.' }),
    )
    return true // keep the message channel open for the async sendResponse
  }
})
