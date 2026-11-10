#!/usr/bin/env node
/**
 * Wrap client/index.cjs + client/form-logic.js into the lazy-CJS
 * window.__ModuleLoader__.load factory dsh serves at /plugins.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let logic = readFileSync(join(ROOT, 'client/form-logic.js'), 'utf8')
logic = logic.replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ')
let body = readFileSync(join(ROOT, 'client/index.cjs'), 'utf8')
body = body.replace(/const \{[\s\S]*?\} = require\('\.\/form-logic\.js'\)\n\n/, '')
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
