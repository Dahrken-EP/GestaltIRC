// Where installed plugins and their data are kept in this browser, per account. The manager also keeps a
// copy on the bouncer, which is what follows the account to another browser; this one is what works at once
// and when the bouncer cannot be reached.

import { parseStored } from './manifest'
import { MAX_STORAGE_CHARS, type InstalledPlugin } from './types'

const LIST = (user: string) => `irc:plugins:${user}`
const DATA = (user: string, name: string) => `irc:plugin-data:${user}:${name}`

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function loadPlugins(user: string): InstalledPlugin[] {
  const list = read(LIST(user))
  if (!Array.isArray(list)) return []
  const out: InstalledPlugin[] = []
  for (const item of list) {
    const p = parseStored(item)
    if (p && !out.some((o) => o.manifest.name === p.manifest.name)) out.push(p)
  }
  return out
}

export function savePlugins(user: string, plugins: InstalledPlugin[]): boolean {
  return write(LIST(user), plugins)
}

export function loadData(user: string, name: string): Record<string, string> {
  const d = read(DATA(user, name))
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {}
  const out: Record<string, string> = {}
  let size = 0
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'string') continue
    size += k.length + v.length
    if (size > MAX_STORAGE_CHARS) break
    out[k] = v
  }
  return out
}

export function saveData(user: string, name: string, data: Record<string, string>): boolean {
  return write(DATA(user, name), data)
}

export function deleteData(user: string, name: string): void {
  try {
    localStorage.removeItem(DATA(user, name))
  } catch {
    // nothing to remove
  }
}

const STAMP = (user: string) => `irc:plugins-at:${user}`

/** When the plugins or their data last changed in this browser, as milliseconds; 0 if never. */
export function loadStamp(user: string): number {
  const v = read(STAMP(user))
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function saveStamp(user: string, ms: number): void {
  write(STAMP(user), ms)
}
