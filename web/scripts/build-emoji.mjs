// Builds src/lib/emoji-data.json, the full emoji list the picker and the :shortcode: completion load on demand,
// from the Emojibase data (MIT licence, https://emojibase.dev). It is committed, so nothing needs to run this:
//
//   mkdir /tmp/emoji && cd /tmp/emoji && npm init -y && npm install emojibase-data@16
//   node scripts/build-emoji.mjs /tmp/emoji/node_modules/emojibase-data
//
// Skin-tone variants are left out (the base emoji is kept), and so are the components (skin tone swatches, hair).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/build-emoji.mjs PATH/TO/emojibase-data')
  process.exit(2)
}
const read = (p) => JSON.parse(readFileSync(join(src, p), 'utf8'))
const data = read('en/data.json')
const shortcodes = read('en/shortcodes/github.json')
const messages = read('en/messages.json')

// Group keys as the picker shows them, in Emojibase's order. "component" is dropped.
const groups = messages.groups.filter((g) => g.key !== 'component').sort((a, b) => a.order - b.order)
const groupIndex = new Map(groups.map((g, i) => [g.order, i]))
const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/&/g, 'and')

const entries = []
for (const e of data) {
  if (e.group === undefined || !groupIndex.has(e.group)) continue
  const codes = [shortcodes[e.hexcode]].flat().filter(Boolean)
  entries.push([e.emoji, e.label, (e.tags ?? []).join(' '), groupIndex.get(e.group), codes.join(' ')])
}

const out = { groups: groups.map((g) => title(g.message)), emoji: entries }
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'emoji-data.json')
writeFileSync(file, JSON.stringify(out))
console.log(`${entries.length} emoji in ${groups.length} groups, ${JSON.stringify(out).length} bytes -> ${file}`)
