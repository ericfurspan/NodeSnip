// src/content.js
import { captureElement, classifyCaptureError } from './capture.js'

// Marker added to injected top-level nodes for DOM inspection. Ownership itself is
// reference-based because a page can reuse any public attribute or ID.
const NS = 'data-nodesnip'
const ownedNodes = new Set()

function ownNode(el) {
  el.setAttribute(NS, '')
  ownedNodes.add(el)
  return el
}

function getOwnedNodeById(id) {
  for (const el of ownedNodes) {
    if (el.id === id && el.isConnected) return el
  }
  return null
}

function removeOwnedNode(el) {
  if (!el) return
  el.remove()
  ownedNodes.delete(el)
}

function removeAllOwnedNodes() {
  for (const el of ownedNodes) el.remove()
  ownedNodes.clear()
}

if (!window.__nodeSnipInjected) {
  window.__nodeSnipInjected = true
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'activate') activatePicker()
  })
  activatePicker()
}

function activatePicker() {
  // Declared before cleanup() to avoid temporal dead zone
  let onDocumentMousedown = null
  cleanup()

  // ── Overlay — captures pointer events ────────────────────────────────────

  const overlay = ownNode(document.createElement('div'))
  overlay.id = 'nodesnip-overlay'
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    background: 'transparent',
  })

  // ── Highlight — hover indicator (#1a73e8 border) ───────────────────────────

  const highlight = ownNode(document.createElement('div'))
  highlight.id = 'nodesnip-highlight'
  Object.assign(highlight.style, {
    position: 'fixed',
    zIndex: '2147483647',
    pointerEvents: 'none',
    border: '2px solid #1a73e8',
    backgroundColor: 'transparent',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.7)',
    display: 'none',
  })

  // ── Reticle — locked-state indicator (corner brackets + crosshair) ──

  const reticle = ownNode(document.createElement('div'))
  reticle.id = 'nodesnip-reticle'
  Object.assign(reticle.style, {
    position: 'fixed',
    zIndex: '2147483647',
    pointerEvents: 'none',
    display: 'none',
    backgroundColor: 'rgba(255,45,120,0.07)',
  })

  // Corner brackets: TL, TR, BL, BR
  ;[
    { top: '0',    left: '0',  borderTop: '2px solid #1a73e8', borderLeft: '2px solid #1a73e8'  },
    { top: '0',    right: '0', borderTop: '2px solid #1a73e8', borderRight: '2px solid #1a73e8' },
    { bottom: '0', left: '0',  borderBottom: '2px solid #1a73e8', borderLeft: '2px solid #1a73e8'  },
    { bottom: '0', right: '0', borderBottom: '2px solid #1a73e8', borderRight: '2px solid #1a73e8' },
  ].forEach(styles => {
    const el = document.createElement('div')
    Object.assign(el.style, { position: 'absolute', width: '12px', height: '12px', boxShadow: '0 0 0 1px rgba(0,0,0,0.7)', ...styles })
    reticle.appendChild(el)
  })

  const crossH = document.createElement('div')
  Object.assign(crossH.style, {
    position: 'absolute', top: '50%', left: '0',
    width: '100%', height: '1px',
    background: 'rgba(255,255,255,0.45)',
    transform: 'translateY(-50%)',
  })
  reticle.appendChild(crossH)

  const crossV = document.createElement('div')
  Object.assign(crossV.style, {
    position: 'absolute', left: '50%', top: '0',
    width: '1px', height: '100%',
    background: 'rgba(255,255,255,0.45)',
    transform: 'translateX(-50%)',
  })
  reticle.appendChild(crossV)

  // ── Banner ────────────────────────────────────────────────────────────────

  const banner = ownNode(document.createElement('div'))
  banner.id = 'nodesnip-banner'
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0', left: '0', right: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
    backgroundColor: 'rgba(0,0,0,0.92)',
    color: '#fff',
    padding: '9px 20px',
    fontSize: '13px',
    fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    textAlign: 'center',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    letterSpacing: '0.01em',
  })
  renderBanner(false)

  document.body.appendChild(overlay)
  document.body.appendChild(highlight)
  document.body.appendChild(reticle)
  document.body.appendChild(banner)

  let currentTarget = null
  let shiftHeld = false
  let frozenTarget = null

  // ── Position helpers ──────────────────────────────────────────────────────

  function positionHighlight(r) {
    Object.assign(highlight.style, {
      display: 'block',
      top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px',
    })
  }

  function positionReticle(r) {
    Object.assign(reticle.style, {
      display: 'block',
      top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px',
    })
  }

  // ── Frozen state helpers ──────────────────────────────────────────────────

  function setFrozen(frozen) {
    if (frozen) {
      highlight.style.display = 'none'
      reticle.style.borderRadius = getComputedStyle(frozenTarget).borderRadius
      positionReticle(frozenTarget.getBoundingClientRect())
      banner.style.borderBottomColor = 'rgba(255,255,255,0.15)'
      renderBanner(true)
    } else {
      reticle.style.display = 'none'
      banner.style.borderBottomColor = 'rgba(255,255,255,0.1)'
      renderBanner(false)
    }
  }

  // Builds the banner content with DOM APIs (no innerHTML). The unlocked-state dot
  // pulses via the Web Animations API rather than an injected @keyframes stylesheet.
  function renderBanner(locked) {
    banner.replaceChildren()

    const dot = document.createElement('span')
    Object.assign(dot.style, {
      display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%',
      background: '#fff', marginRight: '9px', verticalAlign: 'middle',
    })
    if (!locked && typeof dot.animate === 'function') {
      dot.animate(
        [{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }],
        { duration: 2000, iterations: Infinity, easing: 'ease-in-out' },
      )
    }

    const kbd = document.createElement('span')
    Object.assign(kbd.style, {
      fontSize: '11px', background: 'rgba(255,255,255,0.1)',
      border: '1px solid rgba(255,255,255,0.18)', padding: '1px 6px', borderRadius: '3px',
    })
    kbd.textContent = locked ? 'Shift' : 'Esc'

    banner.append(
      dot,
      locked
        ? 'Node locked — click to capture · release '
        : 'NodeSnip — hover to select, click to capture · ',
      kbd,
      locked ? ' to resume' : ' to cancel',
    )
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  function reportCaptureError(err, action) {
    const { expected, message } = classifyCaptureError(err, action)
    if (expected) {
      console.warn('[NodeSnip] Capture skipped (expected limitation):', err?.message ?? String(err))
    } else {
      console.error(`[NodeSnip] ${action} failed:`, err)
    }
    showError(message)
    try { chrome.runtime.sendMessage({ action: 'pickerCancelled' }) } catch {}
  }

  // Every action is the same pipeline around a different destination: tear down the
  // picker, show the spinner, yield a frame so it actually paints, capture, hand the
  // blob to `sink`, then clear the badge. `action` only names the failure wording.
  async function runCaptureAction(target, action, sink) {
    cleanup()
    showSpinner()
    await new Promise(r => setTimeout(r, 0))
    try {
      await sink(await captureElement(target))
      try { chrome.runtime.sendMessage({ action: 'pickerCancelled' }) } catch {}
    } catch (err) {
      reportCaptureError(err, action)
    } finally {
      removeSpinner()
    }
  }

  // ── Action dialog ─────────────────────────────────────────────────────────

  function showActionDialog(x, y, target) {
    // Dismantle the picker controls; reticle stays visible over the selection
    overlay.remove()
    banner.remove()
    document.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('blur', onBlur)

    const dialog = ownNode(document.createElement('div'))
    dialog.id = 'nodesnip-dialog'
    Object.assign(dialog.style, {
      position: 'fixed',
      zIndex: '2147483647',
      backgroundColor: 'rgba(0,0,0,0.92)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '8px',
      padding: '6px',
      display: 'flex',
      gap: '2px',
      fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    })

    const btnDefs = [
      {
        id: 'ns-btn-copy',
        label: 'COPY',
        icon: [
          ['rect', { x: 5, y: 5, width: 8, height: 9, rx: 1, stroke: 'currentColor', 'stroke-width': 1.5 }],
          ['path', { d: 'M3 11V3a1 1 0 011-1h6', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
        ],
        handler: () => runCaptureAction(target, 'Copy', copyBlobToClipboard),
      },
      {
        id: 'ns-btn-download',
        label: 'PNG',
        icon: [
          ['path', { d: 'M8 2v7', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }],
          ['path', { d: 'M5 7l3 3 3-3', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
          ['path', { d: 'M3 13h10', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }],
        ],
        handler: () => runCaptureAction(target, 'Download', downloadBlobAsPng),
      },
    ]

    const buttons = []
    let actionStarted = false
    for (const { id, label, icon, handler } of btnDefs) {
      const btn = document.createElement('button')
      btn.id = id
      Object.assign(btn.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
        padding: '8px 12px',
        border: 'none',
        background: 'transparent',
        color: '#fff',
        cursor: 'pointer',
        borderRadius: '5px',
        fontSize: '10px',
        fontWeight: '700',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        lineHeight: '1',
        fontFamily: 'inherit',
      })
      const labelEl = document.createElement('span')
      labelEl.textContent = label
      btn.append(makeSvgIcon(icon), labelEl)
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.08)' })
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent' })
      btn.addEventListener('click', () => {
        if (actionStarted) return
        actionStarted = true
        for (const actionButton of buttons) actionButton.disabled = true
        handler()
      })
      buttons.push(btn)
      dialog.appendChild(btn)
    }

    document.body.appendChild(dialog)

    // Position: centered below cursor, clamped to viewport
    const dw = dialog.offsetWidth
    const dh = dialog.offsetHeight
    const margin = 8
    let left = Math.round(x - dw / 2)
    let top  = Math.round(y + 16)
    if (left < margin) left = margin
    if (left + dw > window.innerWidth  - margin) left = window.innerWidth  - dw - margin
    if (top  + dh > window.innerHeight - margin) top  = y - dh - 8
    if (top  < margin) top = margin
    dialog.style.left = left + 'px'
    dialog.style.top  = top  + 'px'

    // Dismiss on outside click (deferred so this click event doesn't immediately fire it)
    onDocumentMousedown = (e) => {
      if (!dialog.contains(e.target)) {
        cleanup()
        try { chrome.runtime.sendMessage({ action: 'pickerCancelled' }) } catch {}
      }
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onDocumentMousedown, { capture: true })
    }, 0)
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  function onMouseMove(e) {
    if (shiftHeld) return

    const els = document.elementsFromPoint(e.clientX, e.clientY)
    // Exclude only the exact nodes we injected. A page may coincidentally use the
    // same attribute or IDs, so DOM markers alone are not proof of ownership.
    const target = els.find(el => !ownedNodes.has(el))
    if (!target || target === document.body || target === document.documentElement) {
      highlight.style.display = 'none'
      currentTarget = null
      return
    }
    currentTarget = target
    positionHighlight(target.getBoundingClientRect())
  }

  function onClick(e) {
    if (!currentTarget) return
    e.preventDefault()
    e.stopPropagation()
    showActionDialog(e.clientX, e.clientY, currentTarget)
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      cleanup()
      try { chrome.runtime.sendMessage({ action: 'pickerCancelled' }) } catch {}
      return
    }
    if (getOwnedNodeById('nodesnip-dialog')) return
    if (e.key === 'Shift' && !shiftHeld && currentTarget) {
      shiftHeld = true
      frozenTarget = currentTarget
      setFrozen(true)
    }
  }

  function onKeyUp(e) {
    if (e.key === 'Shift' && shiftHeld) {
      shiftHeld = false
      frozenTarget = null
      setFrozen(false)
    }
  }

  function onScroll() {
    if (!frozenTarget) return
    positionReticle(frozenTarget.getBoundingClientRect())
  }

  function onBlur() {
    if (!shiftHeld) return
    shiftHeld = false
    frozenTarget = null
    setFrozen(false)
  }

  overlay.addEventListener('mousemove', onMouseMove)
  overlay.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('blur', onBlur)

  function cleanup() {
    removeAllOwnedNodes()
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('blur', onBlur)
    if (onDocumentMousedown) {
      document.removeEventListener('mousedown', onDocumentMousedown, { capture: true })
      onDocumentMousedown = null
    }
  }
}

// Builds an 18×18 SVG icon from a spec of [tagName, attributes] entries, using
// createElementNS (no innerHTML). Markup is fully static — defined in the call site.
const SVG_NS = 'http://www.w3.org/2000/svg'
function makeSvgIcon(nodes) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  for (const [tag, attrs] of nodes) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const k in attrs) node.setAttribute(k, attrs[k])
    svg.appendChild(node)
  }
  return svg
}

function showSpinner() {
  const el = ownNode(document.createElement('div'))
  el.id = 'nodesnip-spinner'
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    color: '#fff',
    fontSize: '16px',
    fontFamily: 'system-ui, sans-serif',
  })
  const box = document.createElement('div')
  box.style.textAlign = 'center'

  const ring = document.createElement('div')
  Object.assign(ring.style, {
    width: '32px', height: '32px',
    border: '3px solid rgba(255,255,255,0.3)', borderTopColor: '#fff',
    borderRadius: '50%', margin: '0 auto 12px',
  })
  if (typeof ring.animate === 'function') {
    ring.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 800, iterations: Infinity, easing: 'linear' },
    )
  }

  box.append(ring, 'Capturing…')
  el.appendChild(box)
  document.body.appendChild(el)
}

function removeSpinner() {
  removeOwnedNode(getOwnedNodeById('nodesnip-spinner'))
}

function showError(message) {
  removeOwnedNode(getOwnedNodeById('nodesnip-error'))
  const el = ownNode(document.createElement('div'))
  el.id = 'nodesnip-error'
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    backgroundColor: 'rgba(220,38,38,0.95)',
    color: '#fff',
    padding: '10px 20px',
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: 'system-ui, sans-serif',
    pointerEvents: 'none',
    maxWidth: '420px',
    textAlign: 'center',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  })
  el.textContent = `NodeSnip: ${message}`
  document.body.appendChild(el)
  setTimeout(() => removeOwnedNode(el), 4000)
}

function titleToFilename(title) {
  return (title || '')
    .toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'nodesnip'
}

// ── Capture destinations ────────────────────────────────────────────────────
// Each takes the captured PNG blob and puts it somewhere. Anything they throw is
// classified and shown by the caller, so a destination-specific explanation goes
// on the error as `userMessage`.

async function copyBlobToClipboard(blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch (err) {
    err.userMessage = 'Copy failed — Chrome could not write the image to your clipboard.'
    throw err
  }
}

function downloadBlobAsPng(blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${titleToFilename(document.title)}.png`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
