// src/capture.js
//
// Turning a DOM element into a PNG Blob, and deciding what to say when that fails.
//
// The picker owns selection and UI; this module owns rendering. It holds the
// html2canvas configuration, the workarounds that configuration needs (backdrop
// resolution, the negative-SVG-rect clamp), and the classification of what went
// wrong — including the user-facing wording, since the pre-flight checks below are
// already the place that knows *why* a capture can't happen.
//
// Nothing here touches the picker's DOM or its state: capture takes an element and
// returns a Blob.

import html2canvas from 'html2canvas'
import { firstOpaqueBackgroundColor, normalizeDocumentColors } from './color-utils.js'
import { TARGET } from './target.js'

// Messages for failures we don't recognise, keyed by the action the user chose.
// Expected limitations carry their own userMessage from the pre-flight checks.
const ACTION_FALLBACK_MESSAGE = {
  Copy: 'Copy failed — capture or clipboard error.',
  Download: 'Download failed — please try again.',
}
const EXPECTED_LIMIT_MESSAGE =
  'Can\'t capture — the element may be inside a protected or cross-origin frame.'
const UNKNOWN_FAILURE_MESSAGE = 'Capture failed.'

// Determines the backdrop to capture a node-scoped element against. html2canvas
// otherwise defaults to opaque WHITE, which makes a translucent element (e.g. a
// shadcn card with a semi-transparent fill, or any element with no background of
// its own) composite over white and render as a washed-out grey box. Instead we
// walk from the target up through its ancestors (and on to body/html) and use the
// first fully opaque background colour we find — the page's real backdrop — so
// translucent fills composite over the colour they actually sit on. Falls back to
// white when nothing opaque is found (e.g. a genuinely transparent page).
function resolveCaptureBackground(target) {
  const view = target.ownerDocument.defaultView || window
  const colors = []
  for (let el = target; el; el = el.parentElement) {
    colors.push(view.getComputedStyle(el).backgroundColor)
  }
  return firstOpaqueBackgroundColor(colors) ?? '#ffffff'
}

// Clamps negative SVG <rect> width/height in a cloned document.
//
// Sub-pixel layout and CSS transforms can produce negative values. These cause
// browser SVG validation errors and may abort html2canvas. Both the HTML
// presentation attribute and the CSS-applied value have to be checked — either can
// carry the negative on its own.
//
// A document with no defaultView has no getComputedStyle, so there is nothing to
// read and this is a no-op. Exported for testing; in production it runs from the
// onclone hook below.
export function clampNegativeSvgRects(doc) {
  const view = doc?.defaultView
  if (!view) return

  doc.querySelectorAll('rect').forEach(rect => {
    const aw = parseFloat(rect.getAttribute('width'))
    const ah = parseFloat(rect.getAttribute('height'))
    if (!isNaN(aw) && aw < 0) rect.setAttribute('width', '0')
    if (!isNaN(ah) && ah < 0) rect.setAttribute('height', '0')
    const cs = view.getComputedStyle(rect)
    const cw = parseFloat(cs.width)
    const ch = parseFloat(cs.height)
    if (!isNaN(cw) && cw < 0) rect.style.setProperty('width', '0px', 'important')
    if (!isNaN(ch) && ch < 0) rect.style.setProperty('height', '0px', 'important')
  })
}

// True when an error represents an expected browser limitation (cross-origin frame,
// detached element) rather than a genuine defect. Errors we raise ourselves are
// tagged with `expected`; html2canvas exports no typed errors, so its own failures
// can only be matched on message text.
export function isExpectedCaptureLimit(err) {
  if (err?.expected === true) return true
  const msg = err?.message ?? String(err ?? '')
  return msg.includes('Unable to find element in cloned iframe') ||
         msg.includes('cross-origin') ||
         msg.includes('no longer in the document')
}

// Classifies a capture failure and picks what the user should be told.
// `expected` distinguishes a browser limitation (warn, explain) from a defect
// (error, log it). `action` is the dialog action in progress ('Copy' | 'Download').
export function classifyCaptureError(err, action) {
  const expected = isExpectedCaptureLimit(err)
  const message = err?.userMessage ??
    (expected
      ? EXPECTED_LIMIT_MESSAGE
      : ACTION_FALLBACK_MESSAGE[action] ?? UNKNOWN_FAILURE_MESSAGE)
  return { expected, message }
}

// Page-relative bounding box of `target`, in CSS px. Only the Firefox native-
// capture path needs this: unlike html2canvas (which clones and renders only
// target's own subtree, positioned by the clone's own layout), captureNative
// asks the background script to screenshot the real rendered page, so the rect
// has to be relative to the full document rather than the current viewport —
// getBoundingClientRect() plus the current scroll offsets.
function pageRelativeRect(target) {
  const view = target.ownerDocument.defaultView || window
  const r = target.getBoundingClientRect()
  return {
    x: r.left + view.scrollX,
    y: r.top + view.scrollY,
    width: r.width,
    height: r.height,
  }
}

// Decodes a `data:` PNG URL into a Blob. A network round trip (fetch of the data
// URL) would work too, but this keeps the conversion synchronous and easy to
// unit test without mocking fetch.
function dataUrlToBlob(dataUrl) {
  const [header, base64 = ''] = String(dataUrl).split(',')
  const mime = /^data:(.*?);base64$/.exec(header ?? '')?.[1] ?? 'image/png'
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// Firefox target: Firefox forbids a content script from calling
// document.open()/write() on html2canvas's page-owned clone iframe ("The
// operation is insecure" — see AGENTS.md and issue #21), so instead this asks
// the background script to screenshot the tab region covering `target` with the
// browser's own chrome.tabs.captureTab, and converts the resulting PNG data URL
// to a Blob. Errors — including a rejected or unsuccessful response — propagate
// to the caller for classifyCaptureError, same as an html2canvas failure.
async function captureElementNative(target) {
  const view = target.ownerDocument.defaultView || window
  const response = await chrome.runtime.sendMessage({
    action: 'captureRect',
    rect: pageRelativeRect(target),
    scale: view.devicePixelRatio || 1,
  })
  if (!response?.ok) {
    throw new Error(response?.error || 'Native capture failed.')
  }
  return dataUrlToBlob(response.dataUrl)
}

// Renders `target` to a PNG Blob. Rejects on the pre-flight limits below, on any
// html2canvas failure, and when the canvas can't produce a blob — classify the
// rejection with classifyCaptureError.
export async function captureElement(target) {
  // Pre-flight: reject detached elements before paying the cost of html2canvas.
  // A fast-updating page can remove the selected node between click and capture.
  if (!target.isConnected) {
    const err = new Error('Element is no longer in the document.')
    err.expected = true
    err.userMessage = 'Can\'t capture — the element was removed before the screenshot was taken.'
    throw err
  }

  // Pre-flight: cross-origin iframes cannot be cloned by html2canvas.
  // elementsFromPoint returns the <iframe> element itself for cross-origin frames,
  // and html2canvas will reject with "Unable to find element in cloned iframe".
  if (target.tagName === 'IFRAME') {
    try { void target.contentWindow?.location?.href }
    catch {
      const err = new Error('Cross-origin iframe cannot be captured.')
      err.expected = true
      err.userMessage = 'Can\'t capture — this element is inside a cross-origin frame.'
      throw err
    }
  }

  if (TARGET === 'firefox') {
    return captureElementNative(target)
  }

  const canvas = await html2canvas(target, {
    useCORS: true,
    logging: false,
    // Capture against the page's real background instead of html2canvas's default
    // white, so translucent backgrounds keep their true tone (see helper above).
    backgroundColor: resolveCaptureBackground(target),
    // Fail fast on slow/blocked resources instead of waiting the 15 s default.
    // Complex SPAs (e.g. Cloudflare-protected pages) can have CDN assets that
    // hang on CORS preflight for a long time before the browser gives up.
    imageTimeout: 3000,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    onclone(doc) {
      // Two things abort a capture outright and both are fixable in the clone:
      // invalid SVG geometry, and colour functions html2canvas can't parse
      // (oklch(), color(), color-mix(), and any future CSS colour syntax — it
      // only knows rgb/rgba/hsl/hsla). Each belongs to the module named for it.
      clampNegativeSvgRects(doc)
      normalizeDocumentColors(doc)
    },
  })

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png')
  )
}
