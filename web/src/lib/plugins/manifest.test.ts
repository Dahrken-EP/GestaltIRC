import { describe, expect, it } from 'vitest'
import { parseBundle, parseStored } from './manifest'

const good = { name: 'greeter', version: '1.0.0', description: 'Says hello', permissions: ['events', 'send'], source: 'irc.log("hi")' }
const parse = (o: unknown) => parseBundle(JSON.stringify(o))

describe('parseBundle', () => {
  it('reads a good plugin', () => {
    const r = parse(good)
    expect(r).toEqual({ ok: true, plugin: { manifest: { name: 'greeter', version: '1.0.0', description: 'Says hello', permissions: ['events', 'send'] }, source: 'irc.log("hi")' } })
  })
  it('allows no permissions and no description', () => {
    const r = parse({ ...good, permissions: [], description: undefined })
    expect(r.ok && r.plugin.manifest.description).toBe('')
  })
  it('drops repeated permissions and unknown extra fields', () => {
    const r = parse({ ...good, permissions: ['send', 'send'], evil: { x: 1 } })
    expect(r.ok && r.plugin.manifest.permissions).toEqual(['send'])
    expect(r.ok && Object.keys(r.plugin)).toEqual(['manifest', 'source'])
  })
  it.each([
    ['not json', 'hello'],
    ['an array', '[]'],
    ['null', 'null'],
  ])('rejects %s', (_n, text) => {
    expect(parseBundle(text).ok).toBe(false)
  })
  it.each([
    ['no name', { ...good, name: undefined }],
    ['upper-case name', { ...good, name: 'Greeter' }],
    ['name with a slash', { ...good, name: 'a/b' }],
    ['one-letter name', { ...good, name: 'a' }],
    ['name starting with a digit', { ...good, name: '1abc' }],
    ['long name', { ...good, name: 'a'.repeat(40) }],
    ['bad version', { ...good, version: 'one' }],
    ['no version', { ...good, version: undefined }],
    ['long description', { ...good, description: 'x'.repeat(201) }],
    ['permissions not a list', { ...good, permissions: 'send' }],
    ['unknown permission', { ...good, permissions: ['send', 'network'] }],
    ['permission not a string', { ...good, permissions: [1] }],
    ['empty source', { ...good, source: '  ' }],
    ['source not a string', { ...good, source: 5 }],
    ['huge source', { ...good, source: 'x'.repeat(300_000) }],
  ])('rejects %s', (_n, o) => {
    const r = parse(o)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.length).toBeGreaterThan(5)
  })
})

describe('parseStored', () => {
  it('keeps only granted permissions that were asked for', () => {
    const p = parseStored({ manifest: good, source: good.source, granted: ['send', 'storage', 5], enabled: true })
    expect(p).toMatchObject({ granted: ['send'], enabled: true })
  })
  it('disables anything that is not exactly true', () => {
    expect(parseStored({ manifest: good, source: good.source, granted: [], enabled: 'yes' })?.enabled).toBe(false)
  })
  it('drops what no longer parses', () => {
    expect(parseStored({ manifest: { ...good, name: 'BAD' }, source: 'x', granted: [] })).toBeNull()
    expect(parseStored(null)).toBeNull()
    expect(parseStored('x')).toBeNull()
  })
})
