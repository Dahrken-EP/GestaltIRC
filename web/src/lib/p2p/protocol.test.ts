import { describe, expect, it } from 'vitest'
import { formatBytes, MAX_CHAT_CHARS, MAX_FILE_BYTES, newId, parseControl, safeMime, sanitizeFileName } from './protocol'

describe('parseControl', () => {
  it('reads each known message', () => {
    expect(parseControl('{"t":"chat","id":"abc123","text":"hi"}')).toEqual({ t: 'chat', id: 'abc123', text: 'hi' })
    expect(parseControl('{"t":"file-offer","id":"abc123","name":"a.png","size":10,"mime":"image/png"}')).toEqual({
      t: 'file-offer',
      id: 'abc123',
      name: 'a.png',
      size: 10,
      mime: 'image/png',
    })
    expect(parseControl('{"t":"file-accept","id":"abc123"}')).toEqual({ t: 'file-accept', id: 'abc123' })
    expect(parseControl('{"t":"file-reject","id":"abc123"}')).toEqual({ t: 'file-reject', id: 'abc123' })
    expect(parseControl('{"t":"file-cancel","id":"abc123"}')).toEqual({ t: 'file-cancel', id: 'abc123' })
    expect(parseControl('{"t":"file-done","id":"abc123","ok":true}')).toEqual({ t: 'file-done', id: 'abc123', ok: true })
  })

  it('drops extra fields instead of passing them on', () => {
    const c = parseControl('{"t":"file-accept","id":"abc123","evil":{"x":1}}')
    expect(c).toEqual({ t: 'file-accept', id: 'abc123' })
  })

  it.each([
    ['not json', 'hello'],
    ['array', '[1]'],
    ['null', 'null'],
    ['no type', '{"id":"abc123"}'],
    ['unknown type', '{"t":"exec","id":"abc123"}'],
    ['no id', '{"t":"file-accept"}'],
    ['bad id', '{"t":"file-accept","id":"../../x"}'],
    ['short id', '{"t":"file-accept","id":"ab"}'],
    ['numeric id', '{"t":"file-accept","id":123456}'],
    ['empty chat', '{"t":"chat","id":"abc123","text":""}'],
    ['chat text not a string', '{"t":"chat","id":"abc123","text":5}'],
    ['negative size', '{"t":"file-offer","id":"abc123","name":"a","size":-1,"mime":"x/y"}'],
    ['fractional size', '{"t":"file-offer","id":"abc123","name":"a","size":1.5,"mime":"x/y"}'],
    ['string size', '{"t":"file-offer","id":"abc123","name":"a","size":"10","mime":"x/y"}'],
    ['huge size', `{"t":"file-offer","id":"abc123","name":"a","size":${MAX_FILE_BYTES + 1},"mime":"x/y"}`],
    ['name not a string', '{"t":"file-offer","id":"abc123","name":1,"size":1,"mime":"x/y"}'],
    ['done without ok', '{"t":"file-done","id":"abc123"}'],
  ])('rejects %s', (_label, text) => {
    expect(parseControl(text)).toBeNull()
  })

  it('limits chat length and message size', () => {
    const ok = JSON.stringify({ t: 'chat', id: 'abc123', text: 'x'.repeat(MAX_CHAT_CHARS) })
    expect(parseControl(ok)).not.toBeNull()
    const long = JSON.stringify({ t: 'chat', id: 'abc123', text: 'x'.repeat(MAX_CHAT_CHARS + 1) })
    expect(parseControl(long)).toBeNull()
    expect(parseControl(' '.repeat(30_000) + ok)).toBeNull()
  })

  it('accepts an empty file', () => {
    expect(parseControl('{"t":"file-offer","id":"abc123","name":"e","size":0,"mime":"text/plain"}')).toMatchObject({ size: 0 })
  })

  it('cleans the name and media type in an offer', () => {
    const c = parseControl('{"t":"file-offer","id":"abc123","name":"../../etc/passwd","size":1,"mime":"text/html; charset=x"}')
    expect(c).toMatchObject({ name: 'passwd', mime: 'application/octet-stream' })
  })
})

describe('sanitizeFileName', () => {
  it.each([
    ['photo.jpg', 'photo.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\x.txt', 'x.txt'],
    ['a/b/c.txt', 'c.txt'],
    ['  .hidden  ', 'hidden'],
    ['bad<>:"|?*name', 'bad_______name'],
    ['tab\tname\u0000.txt', 'tab_name_.txt'],
    ['', 'file'],
    ['...', 'file'],
    ['/', 'file'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['lpt1', '_lpt1'],
    ['console.txt', 'console.txt'],
  ])('%j -> %j', (input, want) => {
    expect(sanitizeFileName(input)).toBe(want)
  })

  it('removes bidirectional overrides that disguise an extension', () => {
    expect(sanitizeFileName('invoice\u202Etxt.exe')).toBe('invoicetxt.exe')
    expect(sanitizeFileName('a\u2066b\u2069')).toBe('ab')
  })

  it('shortens long names but keeps a short extension', () => {
    const n = sanitizeFileName('a'.repeat(500) + '.png')
    expect(n.length).toBe(120)
    expect(n.endsWith('.png')).toBe(true)
    expect(sanitizeFileName('b'.repeat(500)).length).toBe(120)
  })
})

describe('safeMime', () => {
  it('keeps plain media types and lower-cases them', () => {
    expect(safeMime('image/PNG')).toBe('image/png')
    expect(safeMime('application/vnd.api+json')).toBe('application/vnd.api+json')
  })
  it.each(['', 'text', 'text/html; charset=utf-8', '<script>/x', 'a/b c', 'x'.repeat(200) + '/y'])('replaces %j', (m) => {
    expect(safeMime(m)).toBe('application/octet-stream')
  })
})

describe('newId and formatBytes', () => {
  it('makes ids that pass the id check and rarely repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, newId))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(parseControl(`{"t":"file-accept","id":"${id}"}`)).not.toBeNull()
  })
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
})
