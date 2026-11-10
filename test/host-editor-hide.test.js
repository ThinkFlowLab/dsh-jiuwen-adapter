import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hideHostGenericEditor, watchHostGenericEditor } from '../client/host-editor-hide.js'

/**
 * Tiny DOM sufficient for hideHostGenericEditor: closest('li'),
 * querySelectorAll('p'|'button'), contains, hidden, attributes.
 * Avoids adding a jsdom dependency to this package.
 */
function el(tag, attrs = {}, children = []) {
  const node = {
    tagName: String(tag).toUpperCase(),
    parentElement: null,
    hidden: false,
    attrs: { ...attrs },
    children: [],
    _text: attrs.text || '',
    get textContent() {
      if (this.children.length === 0) return this._text
      return this.children.map(c => c.textContent).join('')
    },
    set textContent(v) { this._text = String(v); this.children = [] },
    getAttribute(name) { return this.attrs[name] ?? null },
    setAttribute(name, value) { this.attrs[name] = String(value) },
    contains(other) {
      if (other === this) return true
      return this.children.some(c => c.contains(other))
    },
    closest(sel) {
      if (sel === 'li' && this.tagName === 'LI') return this
      return this.parentElement ? this.parentElement.closest(sel) : null
    },
    querySelectorAll(sel) {
      const out = []
      const want = String(sel).toUpperCase()
      const walk = (n) => {
        if (n.tagName === want) out.push(n)
        for (const c of n.children) walk(c)
      }
      for (const c of this.children) walk(c)
      return out
    },
  }
  for (const child of children) {
    child.parentElement = node
    node.children.push(child)
  }
  return node
}

function attach(parent, child) {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

function jiuwenRow({ setup = false, extraLi } = {}) {
  const list = el('ul')
  const row = attach(list, el('li'))
  const head = attach(row, el('div'))
  attach(head, el('span', { text: 'JiuwenSwarm' }))
  const actions = attach(head, el('span'))
  const edit = attach(actions, el('button', { 'aria-label': 'Edit JiuwenSwarm', text: 'Edit' }))
  const remove = attach(actions, el('button', { 'aria-label': 'Remove JiuwenSwarm', text: 'Remove' }))

  const our = el('div', { 'data-jiuwen-models-card': '' })
  attach(our, el('p', { text: 'Set the endpoint, API key and model names here.' }))
  attach(our, el('button', { text: 'Apply' }))
  attach(our, el('button', { text: 'Remove' })) // model-row delete, must stay

  const editor = el('div')
  attach(editor, el('p', { text: 'Other fields live in cordis.patch.yml; edit that section directly. (llm-jiuwen)' }))
  const footer = attach(editor, el('div'))
  attach(footer, el('button', { text: 'Cancel' }))
  attach(footer, el('button', { text: 'Apply' }))

  if (setup) {
    attach(row, editor)
    attach(row, our)
  } else {
    attach(row, our)
    attach(row, editor)
  }

  if (extraLi) attach(list, extraLi)
  return { list, row, our, editor, edit, remove }
}

test('hides the host cordis.patch.yml editor and Edit button on the same row only', () => {
  const other = el('li')
  const otherEdit = attach(other, el('button', { 'aria-label': 'Edit DeepSeek', text: 'Edit' }))
  const otherHint = attach(other, el('p', { text: 'Other fields live in cordis.patch.yml; edit that section directly. (llm-deepseek)' }))
  const { our, editor, edit, remove } = jiuwenRow({ extraLi: other })

  hideHostGenericEditor(our)

  assert.equal(editor.hidden, true)
  assert.equal(editor.getAttribute('data-jiuwen-hidden-host-editor'), '1')
  assert.equal(edit.hidden, true)
  assert.equal(edit.getAttribute('data-jiuwen-hidden-host-edit'), '1')
  assert.equal(remove.hidden, false)
  assert.ok(our.querySelectorAll('button').every(b => !b.hidden), 'our Apply/Remove stay visible')
  assert.equal(otherEdit.hidden, false, 'other provider Edit stays')
  assert.equal(otherHint.hidden, false, 'other provider hint stays')
})

test('hides the first-run setup editor that sits above the adapter card', () => {
  const { our, editor, edit } = jiuwenRow({ setup: true })
  hideHostGenericEditor(our)
  assert.equal(editor.hidden, true)
  assert.equal(edit.hidden, true)
})

test('also matches the Chinese hint; no-ops without a row or a DOM', () => {
  const { our, editor } = jiuwenRow()
  const p = editor.children[0]
  p.textContent = '其余字段在 cordis.patch.yml 中，请直接编辑对应段。(llm-jiuwen)'
  hideHostGenericEditor(our)
  assert.equal(editor.hidden, true)

  const orphan = el('div')
  hideHostGenericEditor(orphan)
  hideHostGenericEditor(null)
  hideHostGenericEditor(undefined)
  assert.equal(typeof watchHostGenericEditor(null), 'function')
  watchHostGenericEditor(null)()
})
