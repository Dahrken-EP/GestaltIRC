// Reading a plugin that someone pasted in. It is a single JSON document: the manifest's
// fields plus the code as a string. Everything in it is untrusted until checked here.

import { MAX_SOURCE_CHARS, PERMISSIONS, type InstalledPlugin, type Manifest, type Permission } from './types'

export type ParseResult = { ok: true; plugin: Omit<InstalledPlugin, 'enabled' | 'granted'> } | { ok: false; error: string }

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,16})?$/

export function parseBundle(text: string): ParseResult {
  if (text.length > MAX_SOURCE_CHARS + 5_000) return { ok: false, error: 'That is too large to be a plugin.' }
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return { ok: false, error: 'That is not valid JSON. A plugin is one JSON document with name, version, description, permissions and source.' }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'A plugin is a JSON object.' }
  const m = o as Record<string, unknown>

  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) return { ok: false, error: 'The name must be 2 to 32 characters: lower-case letters, digits and hyphens, starting with a letter.' }
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return { ok: false, error: 'The version must look like 1.0.0.' }
  const description = typeof m.description === 'string' ? m.description : ''
  if (description.length > 200) return { ok: false, error: 'The description is longer than 200 characters.' }
  if (!Array.isArray(m.permissions)) return { ok: false, error: 'permissions must be a list, possibly empty.' }
  const permissions: Permission[] = []
  for (const p of m.permissions) {
    if (typeof p !== 'string' || !(PERMISSIONS as readonly string[]).includes(p)) {
      return { ok: false, error: `Unknown permission ${JSON.stringify(p)}. The known ones are ${PERMISSIONS.join(', ')}.` }
    }
    if (!permissions.includes(p as Permission)) permissions.push(p as Permission)
  }
  if (typeof m.source !== 'string' || m.source.trim() === '') return { ok: false, error: 'source must be the plugin code, as a string.' }
  if (m.source.length > MAX_SOURCE_CHARS) return { ok: false, error: `The code is longer than ${MAX_SOURCE_CHARS} characters.` }

  const manifest: Manifest = { name: m.name, version: m.version, description, permissions }
  return { ok: true, plugin: { manifest, source: m.source } }
}

/** Checks something read back from storage, which another version of this page might have written. */
export function parseStored(o: unknown): InstalledPlugin | null {
  if (!o || typeof o !== 'object') return null
  const s = o as Record<string, unknown>
  const r = parseBundle(JSON.stringify({ ...(s.manifest as object), source: s.source }))
  if (!r.ok) return null
  const granted = Array.isArray(s.granted)
    ? (s.granted.filter((p): p is Permission => typeof p === 'string' && r.plugin.manifest.permissions.includes(p as Permission)) as Permission[])
    : []
  return { ...r.plugin, granted: [...new Set(granted)], enabled: s.enabled === true }
}
