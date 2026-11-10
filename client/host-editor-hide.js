/**
 * Hide dsh's generic unknown-layout Models editor on the JiuwenSwarm row.
 *
 * dsh's built-in Settings → Models layouts only cover `llm-deepseek` and
 * `llm-pi-ai`. Any other configurable-provider namespace (including
 * `llm-jiuwen`) renders a hint — "Other fields live in cordis.patch.yml" —
 * plus a disabled Apply button, on top of this adapter's own card. The
 * adapter cannot change that editor (it lives in dsh core), but the
 * provider-card slot is inside the same row, so we can hide that host UI
 * without touching other providers or the real settings schema.
 *
 * Safe to call with no DOM (Node tests, headless). Always scoped to the
 * closest `li` that contains this card.
 */

const HINT_RE = /cordis\.patch\.yml/i

function isHostEditButton(text, aria) {
  const label = String(text || '').trim()
  if (label === 'Edit' || label === '编辑') return true
  const a = String(aria || '').trim()
  return /^Edit\s+/i.test(a) || /^编辑\s/.test(a)
}

function editorBlockForHint(hintEl, ourRoot, card) {
  let block = hintEl
  for (let n = hintEl.parentElement; n && n !== card; n = n.parentElement) {
    if (n.parentElement === card && !n.contains(ourRoot)) block = n
  }
  return block
}

/**
 * Hide the host's generic cordis.patch.yml editor and its Edit control
 * inside the same provider row as `ourRoot`. No-op without a row.
 */
export function hideHostGenericEditor(ourRoot) {
  if (!ourRoot || typeof ourRoot.closest !== 'function') return
  const card = ourRoot.closest('li')
  if (!card || typeof card.querySelectorAll !== 'function') return

  const paragraphs = card.querySelectorAll('p')
  for (const p of paragraphs) {
    if (ourRoot.contains(p)) continue
    if (!HINT_RE.test(p.textContent || '')) continue
    const block = editorBlockForHint(p, ourRoot, card)
    block.hidden = true
    if (typeof block.setAttribute === 'function') block.setAttribute('data-jiuwen-hidden-host-editor', '1')
  }

  const buttons = card.querySelectorAll('button')
  for (const btn of buttons) {
    if (ourRoot.contains(btn)) continue
    const aria = typeof btn.getAttribute === 'function' ? btn.getAttribute('aria-label') : ''
    if (!isHostEditButton(btn.textContent, aria)) continue
    btn.hidden = true
    if (typeof btn.setAttribute === 'function') btn.setAttribute('data-jiuwen-hidden-host-edit', '1')
  }
}

/**
 * Hide now, and again when dsh later mounts the generic editor (Edit / first-run setup).
 * @returns {() => void} disposer
 */
export function watchHostGenericEditor(ourRoot) {
  hideHostGenericEditor(ourRoot)
  const card = ourRoot && typeof ourRoot.closest === 'function' ? ourRoot.closest('li') : null
  if (!card || typeof MutationObserver !== 'function') return () => {}
  const obs = new MutationObserver(() => hideHostGenericEditor(ourRoot))
  obs.observe(card, { childList: true, subtree: true })
  return () => obs.disconnect()
}
