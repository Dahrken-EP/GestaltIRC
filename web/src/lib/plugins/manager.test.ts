import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from '../irc/message'
import { NetworkState } from '../network.svelte'
import { EXAMPLE_PLUGIN } from './examples'
import { PluginManager } from './manager.svelte'
import { vmSandbox } from './vmsandbox'

class Mem {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

function setup(nick = 'me') {
  const manager = new PluginManager()
  manager.makeSandbox = vmSandbox
  const sent: string[] = []
  const net = new NetworkState('id', 'u/net', nick, (l) => void sent.push(l), { onMention: () => {}, plugins: manager })
  net.nick = nick
  net.viewing = true
  net.setCaps(new Set(['message-tags']))
  net.handleMessage(parse(':b 005 me NETWORK=Net :x')!)
  net.handleMessage(parse(`:${nick}!u@h JOIN #chat`)!)
  net.handleMessage(parse(`:b 353 ${nick} = #chat :${nick} bob`)!)
  net.select('#chat')
  manager.init('matt', { network: (l) => (l === net.label ? net : undefined), active: () => net })
  const feed = (...lines: string[]) => lines.forEach((l) => net.handleMessage(parse(l)!))
  return { manager, net, sent, feed }
}

const bundle = (source: string, permissions: string[] = ['events', 'send', 'output', 'timers', 'storage'], name = 'demo') =>
  JSON.stringify({ name, version: '1.0.0', description: 'test', permissions, source })
const ALL = ['events', 'send', 'output', 'timers', 'storage'] as const
const flush = () => vi.advanceTimersByTimeAsync(0)
const lines = (net: NetworkState) => net.find('#chat')!.messages.map((m) => `${m.kind}:${m.text}`)

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as { localStorage?: unknown }).localStorage = new Mem()
})
afterEach(() => vi.useRealTimers())

describe('PluginManager', () => {
  it('installs a plugin, starts it, and shows what it registered', async () => {
    const { manager } = setup()
    const r = manager.install(bundle(`irc.alias('hi', function () {}); irc.on('TEXT', function () {})`), [...ALL])
    expect(r).toEqual({ ok: true, name: 'demo' })
    await flush()
    const e = manager.entries[0]!
    expect(e).toMatchObject({ status: 'running', aliases: ['hi'], events: ['TEXT'] })
    expect(e.plugin.granted).toEqual([...ALL])
  })

  it('runs an alias typed in a window, with its arguments, and sends what the plugin sends', async () => {
    const { manager, net, sent } = setup()
    manager.install(bundle(`irc.alias('shout', function (args, ctx) { irc.send(args.join(' ').toUpperCase(), ctx.buffer) })`), [...ALL])
    await flush()
    net.submit('/shout hello there')
    await flush()
    expect(sent).toContain('PRIVMSG #chat :HELLO THERE')
    // The typed command itself went nowhere else.
    expect(sent.some((l) => /SHOUT/i.test(l))).toBe(false)
  })

  it('does not let a plugin take over a built-in command', async () => {
    const { manager, net, sent } = setup()
    manager.install(bundle(`irc.alias('join', function () { irc.print('hijacked') })`), [...ALL])
    await flush()
    net.submit('/join #other')
    await flush()
    expect(sent).toContain('JOIN #other')
    expect(manager.entries[0]!.logs.some((l) => l.text.includes('built-in'))).toBe(true)
  })

  it('tells a plugin about events it asked for, and nothing else', async () => {
    const { manager, net, feed } = setup()
    manager.install(bundle(`irc.on('TEXT', function (e) { irc.print('text ' + e.nick + ': ' + e.text + ' in ' + e.buffer + ' on ' + e.network) }); irc.on('JOIN', function (e) { irc.print('join ' + e.nick) })`), [...ALL])
    await flush()
    feed(':bob!u@h PRIVMSG #chat :hello')
    feed(':carol!u@h JOIN #chat')
    feed(':bob!u@h NICK :bobby')
    await flush()
    const out = lines(net).filter((l) => l.includes('[demo]'))
    expect(out).toEqual(['info:[demo] text bob: hello in #chat on Net', 'info:[demo] join carol'])
  })

  it('tells a plugin about mentions, and about connecting', async () => {
    const { manager, net, feed } = setup()
    manager.install(bundle(`irc.on('MENTION', function (e) { irc.print('mention from ' + e.nick) }); irc.on('DISCONNECT', function () { irc.log('gone') })`), [...ALL])
    await flush()
    feed(':bob!u@h PRIVMSG #chat :hey me, look')
    net.connectionLost()
    await flush()
    expect(lines(net)).toContain('info:[demo] mention from bob')
    expect(manager.entries[0]!.logs.map((l) => l.text)).toContain('gone')
  })

  it('does not tell plugins what is said in a direct chat', async () => {
    const { manager, net } = setup()
    manager.install(bundle(`irc.on('TEXT', function (e) { irc.log('saw ' + e.text) })`), [...ALL])
    await flush()
    ;(net as unknown as { onDirectLine(p: string, l: unknown): void }).onDirectLine('bob', { id: 'abc123', text: 'secret', self: false, time: Date.now() })
    await flush()
    expect(manager.entries[0]!.logs.map((l) => l.text)).not.toContain('saw secret')
  })

  it('keeps a plugin from using what it was not given', async () => {
    const { manager, net, sent, feed } = setup()
    manager.install(bundle(`irc.on('TEXT', function () { irc.log('heard') }); irc.alias('x', function () { try { irc.send('nope') } catch (e) { irc.log(e.message) } })`), ['events'])
    await flush()
    net.submit('/x')
    feed(':bob!u@h PRIVMSG #chat :hello')
    await flush()
    expect(manager.entries[0]!.logs.map((l) => l.text)).toEqual(['permission "send" was not granted to this plugin', 'heard'])
    expect(sent.filter((l) => l.includes('nope'))).toEqual([])
    // Events only: even if it asked for the others, the rest were not allowed.
    const m2 = manager.install(bundle(`irc.log('x')`, ['events', 'send']), ['events'])
    expect(m2.ok).toBe(true)
    expect(manager.entries.find((e) => e.plugin.manifest.name === 'demo')!.plugin.granted).toEqual(['events'])
  })

  it('cannot be granted more than it asked for', () => {
    const { manager } = setup()
    manager.install(bundle(`irc.log(1)`, ['events']), ['events', 'send', 'storage'])
    expect(manager.entries[0]!.plugin.granted).toEqual(['events'])
  })

  it('runs timers, and stops them when the plugin is turned off', async () => {
    const { manager, net } = setup()
    manager.install(bundle(`var n = 0; irc.setTimer(1000, function () { irc.print('tick ' + (++n)) }, true)`), [...ALL])
    await flush()
    await vi.advanceTimersByTimeAsync(2500)
    expect(lines(net).filter((l) => l.includes('tick'))).toEqual(['info:[demo] tick 1', 'info:[demo] tick 2'])
    manager.setEnabled('demo', false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(lines(net).filter((l) => l.includes('tick')).length).toBe(2)
    expect(manager.entries[0]!.status).toBe('stopped')
  })

  it('keeps stored data between runs and across a restart of the page', async () => {
    const a = setup()
    a.manager.install(bundle(`irc.alias('count', function () { var n = (irc.storage.get('n') || 0) + 1; irc.storage.set('n', n); irc.print('count ' + n) })`), [...ALL])
    await flush()
    a.net.submit('/count')
    a.net.submit('/count')
    await flush()
    expect(lines(a.net).filter((l) => l.includes('count'))).toEqual(['info:[demo] count 1', 'info:[demo] count 2'])
    // A new page for the same user.
    const b = setup()
    await flush()
    expect(b.manager.entries[0]!.status).toBe('running')
    b.net.submit('/count')
    await flush()
    expect(lines(b.net).filter((l) => l.includes('count'))).toEqual(['info:[demo] count 3'])
  })

  it('keeps plugins and their data apart for different users', async () => {
    const a = setup()
    a.manager.install(bundle(`irc.log(1)`), [...ALL])
    const other = new PluginManager()
    other.makeSandbox = vmSandbox
    other.init('jane', { network: () => undefined, active: () => undefined })
    expect(other.entries).toEqual([])
  })

  it('does not run a plugin that was switched off, after a restart', async () => {
    const a = setup()
    a.manager.install(bundle(`irc.log('started')`), [...ALL])
    await flush()
    a.manager.setEnabled('demo', false)
    const b = setup()
    await flush()
    expect(b.manager.entries[0]).toMatchObject({ status: 'stopped' })
    expect(b.manager.entries[0]!.plugin.enabled).toBe(false)
    expect(b.manager.entries[0]!.logs).toEqual([])
  })

  it('switches off a plugin that fails to load, and says why', async () => {
    const { manager } = setup()
    manager.install(bundle(`throw new Error('broken on purpose')`), [...ALL])
    await flush()
    const e = manager.entries[0]!
    expect(e.status).toBe('failed')
    expect(e.plugin.enabled).toBe(false)
    expect(e.logs.map((l) => l.text).join('\n')).toContain('broken on purpose')
  })

  it('stops a plugin that hangs', async () => {
    const { manager } = setup()
    manager.install(bundle(`irc.log('ok')`), [...ALL])
    await flush()
    // The fake sandbox answers pings, so make it go quiet by stopping its replies.
    manager.makeSandbox = () => ({ post: () => {}, terminate: () => {} })
    manager.install(bundle(`irc.log('never runs')`, [], 'silent'), [])
    await vi.advanceTimersByTimeAsync(5100)
    const e = manager.entries.find((x) => x.plugin.manifest.name === 'silent')!
    expect(e.status).toBe('failed')
    expect(e.error).toBe('did not start in time')
  })

  it('replaces a plugin of the same name, and removes one with its data', async () => {
    const { manager } = setup()
    manager.install(bundle(`irc.storage.set('k', 1); irc.log('v1')`), [...ALL])
    await flush()
    manager.install(JSON.stringify({ name: 'demo', version: '2.0.0', description: '', permissions: [], source: `irc.log('v2')` }), [])
    await flush()
    expect(manager.entries.length).toBe(1)
    expect(manager.entries[0]).toMatchObject({ plugin: { manifest: { version: '2.0.0' } }, status: 'running' })
    manager.remove('demo')
    expect(manager.entries).toEqual([])
    expect((localStorage as unknown as Mem).data.has('irc:plugin-data:matt:demo')).toBe(false)
  })

  it('refuses a plugin it cannot read, and too many plugins', () => {
    const { manager } = setup()
    expect(manager.install('nonsense', [])).toMatchObject({ ok: false })
    for (let i = 0; i < 20; i++) expect(manager.install(bundle(`irc.log(1)`, [], 'p' + String(i).padStart(2, '0')), [])).toMatchObject({ ok: true })
    expect(manager.install(bundle(`irc.log(1)`, [], 'extra'), [])).toMatchObject({ ok: false })
  })

  it('keeps a plugin that may send from running commands that act on the browser', async () => {
    const { manager, net, sent } = setup()
    let rang = 0
    let joined = 0
    ;(net as unknown as { callNick: () => void }).callNick = () => void rang++
    ;(net as unknown as { joinVoice: () => void }).joinVoice = () => void joined++
    manager.install(bundle(`irc.alias('go', function () { irc.send('/voice'); irc.send('/call bob'); irc.send('/direct bob'); irc.send('/clear'); irc.send('hello there') })`, ['send'], 'sneaky'), ['send'])
    await flush()
    net.submit('/go')
    await flush()
    expect(rang + joined).toBe(0)
    expect(net.buffers.some((b) => b.kind === 'p2p')).toBe(false)
    // An ordinary message still goes out.
    expect(sent).toContain('PRIVMSG #chat :hello there')
    const errors = net.find('#chat')!.messages.filter((m) => m.kind === 'error' && m.text.includes('only you can give'))
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })

  it('does not let a plugin that may send write in a direct chat', async () => {
    const { manager, net, sent } = setup()
    net.openDirect('bob', false)
    manager.install(bundle(`irc.alias('go', function () { irc.send('secret words', 'p2p:bob') })`, ['send'], 'sneaky'), ['send'])
    await flush()
    net.select('#chat')
    sent.length = 0
    net.submit('/go')
    await flush()
    expect(sent).toEqual([])
    expect(net.statusBuffer.messages.some((m) => m.text.includes('direct chat'))).toBe(true)
  })

  it('works with the example plugin as shipped', async () => {
    const { manager, net, feed, sent } = setup()
    expect(manager.install(EXAMPLE_PLUGIN, [...ALL])).toEqual({ ok: true, name: 'greeter' })
    await flush()
    net.submit('/greet bob')
    feed(':bob!u@h PRIVMSG #chat :hi me')
    await flush()
    expect(sent).toContain('PRIVMSG #chat :Hello, bob!')
    expect(lines(net).some((l) => l.includes('Mentioned 1 time(s)'))).toBe(true)
  })

  it('does not let plugin-sent lines trigger plugin aliases, so two cannot loop', async () => {
    const { manager, net, sent } = setup()
    manager.install(bundle(`irc.alias('alpha', function () { irc.send('/beta'); irc.log('alpha ran') })`, ['send'], 'one'), ['send'])
    manager.install(bundle(`irc.alias('beta', function () { irc.send('/alpha'); irc.log('beta ran') })`, ['send'], 'two'), ['send'])
    await flush()
    net.submit('/alpha')
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(manager.entries.find((e) => e.plugin.manifest.name === 'one')!.logs.map((l) => l.text)).toEqual(['alpha ran'])
    expect(manager.entries.find((e) => e.plugin.manifest.name === 'two')!.logs).toEqual([])
    // What the plugin sent went to the network as an ordinary command, not to the other plugin.
    expect(sent).toContain('BETA')
  })
})
