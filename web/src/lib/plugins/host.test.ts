import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginInstance, type Sandbox, type Services } from './host'
import type { ToWorker } from './protocol'
import type { InstalledPlugin, Permission, PluginEvent } from './types'

function plugin(granted: Permission[], over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return { manifest: { name: 'demo', version: '1.0.0', description: '', permissions: ['events', 'send', 'output', 'timers', 'storage'] }, source: 'irc.log(1)', granted, enabled: true, ...over }
}

interface Rig {
  inst: PluginInstance
  posted: ToWorker[]
  /** What the plugin "says" to the host. */
  say: (m: unknown) => void
  fatal: (reason: string) => void
  sent: Array<[string, string, string]>
  printed: Array<[string, string, string]>
  logs: Array<[string, string]>
  saved: Array<Record<string, string>>
  stops: string[]
  terminated: () => number
  made: () => number
}

function rig(granted: Permission[], over: Partial<InstalledPlugin> = {}, stored: Record<string, string> = {}): Rig {
  let message!: (d: unknown) => void
  let fatal!: (r: string) => void
  const posted: ToWorker[] = []
  let terminated = 0
  let made = 0
  const r = { sent: [], printed: [], logs: [], saved: [], stops: [] } as unknown as Rig
  const services: Services = {
    context: () => ({ nick: 'me', network: 'net' }),
    send: (line, buffer, network) => r.sent.push([line, buffer, network]),
    print: (text, buffer, network) => r.printed.push([text, buffer, network]),
    loadStorage: () => stored,
    saveStorage: (all) => r.saved.push(all),
    isBuiltin: (n) => ['join', 'msg', 'quit'].includes(n),
    log: (text, kind) => r.logs.push([text, kind]),
    onStop: (reason) => r.stops.push(reason),
  }
  const sandbox: Sandbox = { post: (m) => posted.push(m), terminate: () => void terminated++ }
  r.inst = new PluginInstance(plugin(granted, over), services, (h) => {
    made++
    message = h.message
    fatal = h.fatal
    return sandbox
  })
  r.posted = posted
  r.say = (m) => message(m)
  r.fatal = (x) => fatal(x)
  r.terminated = () => terminated
  r.made = () => made
  return r
}

function running(granted: Permission[], over: Partial<InstalledPlugin> = {}, stored: Record<string, string> = {}): Rig {
  const r = rig(granted, over, stored)
  r.inst.start()
  r.say({ t: 'ready', ok: true })
  return r
}

const ev = (over: Partial<PluginEvent> = {}): PluginEvent => ({ event: 'TEXT', network: 'net', buffer: '#c', nick: 'bob', text: 'hi', target: '', self: false, time: 1, ...over })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('starting', () => {
  it('sends the code, who the user is, and only the permissions granted', () => {
    const r = rig(['send'])
    r.inst.start()
    expect(r.posted[0]).toMatchObject({ t: 'init', source: 'irc.log(1)', info: { plugin: 'demo', version: '1.0.0', nick: 'me', network: 'net', granted: ['send'] } })
    expect(r.inst.status).toBe('starting')
    r.say({ t: 'ready', ok: true })
    expect(r.inst.status).toBe('running')
  })

  it('hands over stored data only with the storage permission', () => {
    expect(rig(['storage'], {}, { a: '1' }).inst.start).toBeDefined()
    const withIt = rig(['storage'], {}, { a: '1' })
    withIt.inst.start()
    expect(withIt.posted[0]).toMatchObject({ storage: { a: '1' } })
    const without = rig(['send'], {}, { a: '1' })
    without.inst.start()
    expect(without.posted[0]).toMatchObject({ storage: {} })
  })

  it('fails with the reason if the code does not load', () => {
    const r = rig([])
    r.inst.start()
    r.say({ t: 'ready', ok: false })
    expect(r.inst.status).toBe('failed')
    expect(r.stops).toEqual(['failed while loading (see the log)'])
    expect(r.terminated()).toBe(1)
  })

  it('fails if it never says it is ready', () => {
    const r = rig([])
    r.inst.start()
    vi.advanceTimersByTime(5100)
    expect(r.inst.status).toBe('failed')
    expect(r.inst.error).toBe('did not start in time')
  })

  it('fails when the sandbox itself fails', () => {
    const r = running([])
    r.fatal('the worker crashed')
    expect(r.inst.status).toBe('failed')
    expect(r.inst.error).toBe('the worker crashed')
  })

  it('does not start twice, and can start again after stopping', () => {
    const r = running([])
    r.inst.start()
    expect(r.made()).toBe(1)
    r.inst.stop()
    expect(r.inst.status).toBe('stopped')
    expect(r.stops).toEqual([]) // stopping on purpose is not a failure
    r.inst.start()
    expect(r.made()).toBe(2)
  })
})

describe('permissions', () => {
  it.each([
    ['send', { t: 'send', line: 'hi', buffer: '', network: '' }],
    ['output', { t: 'print', text: 'hi', buffer: '', network: '' }],
    ['timers', { t: 'timer', id: 1, ms: 500, repeat: false }],
    ['storage', { t: 'store', key: 'k', value: '1' }],
    ['events', { t: 'on', event: 'TEXT' }],
  ])('ignores a message needing "%s" when it was not granted', (_p, msg) => {
    const r = running([])
    r.say(msg)
    expect(r.sent).toEqual([])
    expect(r.printed).toEqual([])
    expect(r.saved).toEqual([])
    expect(r.inst.subscriptions).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(r.posted.filter((m) => m.t === 'fire')).toEqual([])
    expect(r.logs.some(([t]) => t.includes('not granted'))).toBe(true)
  })

  it('acts on a message whose permission was granted', () => {
    const r = running(['send', 'output'])
    r.say({ t: 'send', line: '/msg a b', buffer: '#c', network: 'net' })
    r.say({ t: 'print', text: 'shown', buffer: '', network: '' })
    expect(r.sent).toEqual([['/msg a b', '#c', 'net']])
    expect(r.printed).toEqual([['shown', '', '']])
  })

  it('stops a plugin that keeps sending messages it should not', () => {
    const r = running([])
    for (let i = 0; i < 5; i++) r.say({ t: 'send', line: 'x', buffer: '', network: '' })
    expect(r.inst.status).toBe('failed')
    expect(r.inst.error).toContain('permission')
  })

  it('stops a plugin that sends garbage', () => {
    const r = running(['send'])
    for (let i = 0; i < 5; i++) r.say({ t: 'eval', code: 'x' })
    expect(r.inst.status).toBe('failed')
  })
})

describe('events', () => {
  it('delivers only the events it asked for', () => {
    const r = running(['events'])
    r.say({ t: 'on', event: 'TEXT' })
    r.posted.length = 0
    r.inst.dispatch(ev())
    r.inst.dispatch(ev({ event: 'JOIN' }))
    expect(r.posted.map((m) => m.t === 'event' && m.ev.event)).toEqual(['TEXT'])
  })

  it('does not deliver before it is running or after it stopped', () => {
    const r = rig(['events'])
    r.inst.start()
    r.say({ t: 'on', event: 'TEXT' })
    r.posted.length = 0
    r.inst.dispatch(ev())
    expect(r.posted).toEqual([])
    r.say({ t: 'ready', ok: true })
    r.inst.stop()
    r.inst.dispatch(ev())
    expect(r.posted).toEqual([])
  })

  it('cuts very long text', () => {
    const r = running(['events'])
    r.say({ t: 'on', event: 'TEXT' })
    r.posted.length = 0
    r.inst.dispatch(ev({ text: 'x'.repeat(10_000) }))
    expect((r.posted[0] as { ev: PluginEvent }).ev.text.length).toBe(2000)
  })
})

describe('aliases', () => {
  it('runs its own alias with the arguments, and only its own', () => {
    const r = running([])
    r.say({ t: 'alias', name: 'greet' })
    r.posted.length = 0
    expect(r.inst.runAlias('greet', ['a'], 'a', { network: 'n', buffer: '#c', nick: 'me' })).toBe(true)
    expect(r.posted[0]).toEqual({ t: 'alias', name: 'greet', args: ['a'], raw: 'a', ctx: { network: 'n', buffer: '#c', nick: 'me' } })
    expect(r.inst.runAlias('other', [], '', { network: '', buffer: '', nick: '' })).toBe(false)
  })

  it('cannot take over a built-in command', () => {
    const r = running([])
    r.say({ t: 'alias', name: 'join' })
    expect(r.inst.aliasNames).toEqual([])
    expect(r.inst.runAlias('join', [], '', { network: '', buffer: '', nick: '' })).toBe(false)
    expect(r.logs.some(([t]) => t.includes('built-in'))).toBe(true)
  })

  it.each(['ns', 'nickserv', 'identify', 'oper', 'pass', 'cs'])('cannot take /%s, where passwords are typed', (name) => {
    const r = running([])
    r.say({ t: 'alias', name })
    expect(r.inst.aliasNames).toEqual([])
    expect(r.inst.runAlias(name, ['hunter2'], 'hunter2', { network: '', buffer: '', nick: '' })).toBe(false)
    expect(r.logs.some(([t]) => t.includes('passwords'))).toBe(true)
  })

  it('has a limit', () => {
    const r = running([])
    for (let i = 0; i < 30; i++) r.say({ t: 'alias', name: 'a' + i })
    expect(r.inst.aliasNames.length).toBe(20)
  })
})

describe('timers', () => {
  it('fires once, or repeatedly until cleared', () => {
    const r = running(['timers'])
    r.say({ t: 'timer', id: 1, ms: 500, repeat: false })
    r.say({ t: 'timer', id: 2, ms: 300, repeat: true })
    r.posted.length = 0
    vi.advanceTimersByTime(1000)
    const fires = r.posted.filter((m) => m.t === 'fire').map((m) => (m as { id: number }).id)
    expect(fires.filter((i) => i === 1).length).toBe(1)
    expect(fires.filter((i) => i === 2).length).toBe(3)
    r.say({ t: 'clear', id: 2 })
    r.posted.length = 0
    vi.advanceTimersByTime(2000)
    expect(r.posted.filter((m) => m.t === 'fire')).toEqual([])
  })

  it('has a limit, and stops all of them with the plugin', () => {
    const r = running(['timers'])
    for (let i = 1; i <= 30; i++) r.say({ t: 'timer', id: i, ms: 1000, repeat: true })
    r.posted.length = 0
    vi.advanceTimersByTime(1000)
    expect(r.posted.filter((m) => m.t === 'fire').length).toBe(20)
    r.inst.stop()
    r.posted.length = 0
    vi.advanceTimersByTime(5000)
    expect(r.posted).toEqual([])
  })
})

describe('storage', () => {
  it('keeps and removes values, saving the whole set each time', () => {
    const r = running(['storage'])
    r.say({ t: 'store', key: 'a', value: '1' })
    r.say({ t: 'store', key: 'b', value: '2' })
    r.say({ t: 'store', key: 'a', value: null })
    expect(r.saved).toEqual([{ a: '1' }, { a: '1', b: '2' }, { b: '2' }])
  })

  it('refuses to hold more than its allowance', () => {
    const r = running(['storage'])
    for (let i = 0; i < 20; i++) r.say({ t: 'store', key: 'k' + i, value: 'x'.repeat(7000) })
    const last = r.saved.at(-1)!
    expect(Object.values(last).join('').length).toBeLessThanOrEqual(100_000)
    expect(r.logs.some(([t]) => t.includes('full'))).toBe(true)
  })
})

describe('limits and watching', () => {
  it('allows a burst, then a few a second, and drops the rest', () => {
    const r = running(['send'])
    for (let i = 0; i < 30; i++) r.say({ t: 'send', line: 'x' + i, buffer: '', network: '' })
    expect(r.sent.length).toBe(10)
    vi.advanceTimersByTime(1000)
    for (let i = 0; i < 30; i++) r.say({ t: 'send', line: 'y' + i, buffer: '', network: '' })
    expect(r.sent.length).toBe(15)
  })

  it('stops a plugin that floods for a long time', () => {
    const r = running(['send'])
    for (let i = 0; i < 200; i++) r.say({ t: 'send', line: 'x', buffer: '', network: '' })
    expect(r.inst.status).toBe('failed')
    expect(r.inst.error).toContain('too much')
  })

  it('stops a plugin that stops answering, but not one that does', () => {
    const r = running([])
    // It answers the first two checks.
    for (let i = 1; i <= 2; i++) {
      vi.advanceTimersByTime(2000)
      const ping = r.posted.filter((m) => m.t === 'ping').at(-1) as { n: number }
      r.say({ t: 'pong', n: ping.n })
    }
    vi.advanceTimersByTime(4000)
    expect(r.inst.status).toBe('running')
    // Then it hangs.
    vi.advanceTimersByTime(2000 + 5000)
    expect(r.inst.status).toBe('failed')
    expect(r.inst.error).toBe('stopped responding')
    expect(r.stops).toEqual(['stopped responding'])
  })

  it('ignores a pong for an old check', () => {
    const r = running([])
    vi.advanceTimersByTime(2000)
    r.say({ t: 'pong', n: 999 })
    vi.advanceTimersByTime(5100)
    expect(r.inst.status).toBe('failed')
  })
})
