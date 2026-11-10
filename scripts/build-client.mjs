#!/usr/bin/env node
/**
 * Wrap client/index.cjs + client/*.js helpers into the lazy-CJS
 * window.__ModuleLoader__.load factory dsh serves at /plugins.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HELPERS = ['form-logic.js', 'host-editor-hide.js']

let logic = ''
for (const file of HELPERS) {
  let src = readFileSync(join(ROOT, 'client', file), 'utf8')
  src = src.replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ')
  logic += src + '\n'
}

let body = readFileSync(join(ROOT, 'client/index.cjs'), 'utf8')
// Drop helper imports (inlined above). `[^}]` keeps the match from starting
// at the earlier `require('react')` destructure and deleting it.
for (const file of HELPERS) {
  const re = new RegExp(String.raw`^const \{[^}]*\} = require\('\./` + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`'\)\n?`, 'm')
  body = body.replace(re, '')
}
if (!body.includes("require('react')")) throw new Error('client build dropped the react import')
if (body.includes("require('./form-logic.js')") || body.includes("require('./host-editor-hide.js')")) {
  throw new Error('client build left a helper require in the factory body')
}

const indented = (logic + '\n' + body).split('\n').map(l => l ? `\t\t${l}` : l).join('\n')
const wrapped = `window.__ModuleLoader__.load({
\tid: "@dsh-jiuwen/adapter",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indented}
\t\treturn module.exports;
\t}
});
`
const out = join(ROOT, 'lib/client.js')
writeFileSync(out, wrapped)
console.log(`wrote ${out} (${Buffer.byteLength(wrapped)} bytes)`)
