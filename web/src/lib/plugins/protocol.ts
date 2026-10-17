// The messages between the page (the host) and a plugin's worker. The worker runs code the
// user pasted in, so every message from it is checked here, field by field, before the host
// acts on it. Messages to the worker are built by the host and need no checking.

import { EVENTS, MAX_STORAGE_VALUE_CHARS, MAX_TEXT_CHARS, MAX_TIMERS, MIN_TIMER_MS, type EventName, type Permission, type PluginEvent } from './types'

/** Host to worker. */
export type ToWorker =
  | { t: 'init'; source: string; info: { plugin: string; version: string; nick: string; network: string; granted: Permission[] }; storage: Record<string, string> }
  | { t: 'event'; ev: PluginEvent }
  | { t: 'alias'; name: string; args: string[]; raw: string; ctx: { network: string; buffer: string; nick: string } }
  | { t: 'fire'; id: number }
  | { t: 'ping'; n: number }

/** Worker to host, after checking. */
export type FromWorker =
  | { t: 'ready'; ok: boolean }
  | { t: 'pong'; n: number }
  | { t: 'log'; text: string }
  | { t: 'error'; text: string }
  | { t: 'on'; event: EventName }
  | { t: 'alias'; name: string }
  | { t: 'send'; line: string; buffer: string; network: string }
  | { t: 'print'; text: string; buffer: string; network: string }
  | { t: 'timer'; id: number; ms: number; repeat: boolean }
  | { t: 'clear'; id: number }
  | { t: 'store'; key: string; value: string | null }

const ALIAS_RE = /^[a-z][a-z0-9_]{0,23}$/

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

/** Checks one message from the worker. Returns null for anything that is not exactly one of the known shapes. */
export function parseFromWorker(d: unknown): FromWorker | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const m = d as Record<string, unknown>
  switch (m.t) {
    case 'ready':
      return typeof m.ok === 'boolean' ? { t: 'ready', ok: m.ok } : null
    case 'pong':
      return Number.isSafeInteger(m.n) ? { t: 'pong', n: m.n as number } : null
    case 'log':
      return str(m.text, MAX_TEXT_CHARS * 2) ? { t: 'log', text: m.text } : null
    case 'error':
      return str(m.text, MAX_TEXT_CHARS * 2) ? { t: 'error', text: m.text } : null
    case 'on':
      return typeof m.event === 'string' && (EVENTS as readonly string[]).includes(m.event) ? { t: 'on', event: m.event as EventName } : null
    case 'alias':
      return typeof m.name === 'string' && ALIAS_RE.test(m.name) ? { t: 'alias', name: m.name } : null
    case 'send':
      return str(m.line, MAX_TEXT_CHARS) && m.line.trim() !== '' && str(m.buffer, 200) && str(m.network, 100)
        ? { t: 'send', line: m.line, buffer: m.buffer, network: m.network }
        : null
    case 'print':
      return str(m.text, MAX_TEXT_CHARS) && str(m.buffer, 200) && str(m.network, 100) ? { t: 'print', text: m.text, buffer: m.buffer, network: m.network } : null
    case 'timer':
      return Number.isSafeInteger(m.id) && (m.id as number) > 0 && (m.id as number) <= 1_000_000 && Number.isFinite(m.ms) && (m.ms as number) >= 0 && (m.ms as number) <= 2_147_483_647 && typeof m.repeat === 'boolean'
        ? { t: 'timer', id: m.id as number, ms: Math.max(MIN_TIMER_MS, Math.floor(m.ms as number)), repeat: m.repeat }
        : null
    case 'clear':
      return Number.isSafeInteger(m.id) ? { t: 'clear', id: m.id as number } : null
    case 'store':
      if (!str(m.key, 64) || m.key === '') return null
      if (m.value === null) return { t: 'store', key: m.key, value: null }
      return str(m.value, MAX_STORAGE_VALUE_CHARS) ? { t: 'store', key: m.key, value: m.value } : null
    default:
      return null
  }
}

/** Which permission each kind of message needs. Messages not listed need none. */
export const NEEDS: Partial<Record<FromWorker['t'], Permission>> = {
  on: 'events',
  send: 'send',
  print: 'output',
  timer: 'timers',
  store: 'storage',
}

export { MAX_TIMERS }
