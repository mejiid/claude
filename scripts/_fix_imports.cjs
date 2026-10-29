// One-off codemod: add .js extensions to relative imports in cloud/src (ESM requirement).
// Special case: './schema' is a directory import -> './schema/index.js'.
const fs = require('fs')
const path = require('path')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = walk(path.join(__dirname, '..', 'src'))
let changed = 0
const re = /(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const next = src.replace(re, (m, pre, q, spec) => {
    if (spec.endsWith('.js') || spec.endsWith('.json')) return m
    if (spec.endsWith('/schema')) return pre + q + spec + '/index.js' + q
    return pre + q + spec + '.js' + q
  })
  if (next !== src) {
    fs.writeFileSync(f, next)
    changed++
    console.log('updated', f)
  }
}
console.log('files changed:', changed)
