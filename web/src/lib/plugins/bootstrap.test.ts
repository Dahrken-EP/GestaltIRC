// The tests run on Node. The browser build has no Node types.
// @ts-expect-error no @types/node
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP } from './bootstrap'
import { parseFromWorker } from './protocol'

/** A stand-in for a worker: a global with the dangerous things present, and a port to the page. */
function worker(initial: { source: string; granted?: string[]; storage?: Record<string, string> }) {
  const out: unknown[] = []
  const listeners: Array<(e: unknown) => void> = []
  const port = { postMessage: (m: unknown) => out.push(JSON.parse(JSON.stringify(m))), onmessage: null as null | ((e: { data: unknown }) => void) }
  const sandbox: Record<string, unknown> = {
    fetch: () => 'network!', XMLHttpRequest: class {}, WebSocket: class {}, importScripts: () => 0, Worker: class {},
    indexedDB: {}, caches: {}, BroadcastChannel: class {}, postMessage: () => 'escaped!', setTimeout: () => 0, setInterval: () => 0,
    navigator: { userAgent: 'x' }, location: { href: 'blob:null/x' }, Notification: class {},
    addEventListener: (_t: string, f: (e: unknown) => void) => listeners.push(f),
    removeEventListener: (_t: string, f: (e: unknown) => void) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1) },
  }
  sandbox.self = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(BOOTSTRAP, ctx)
  expect(listeners.length).toBe(1)
  listeners[0]!({ data: { t: 'port' }, ports: [port] })
  const to = (m: unknown) => port.onmessage!({ data: m })
  to({
    t: 'init',
    source: initial.source,
    info: { plugin: 'p', version: '1.0.0', nick: 'me', network: 'net', granted: initial.granted ?? [] },
    storage: initial.storage ?? {},
  })
  return { out, to, sandbox, listeners }
}

const logs = (out: unknown[]) => out.filter((m) => (m as { t: string }).t === 'log').map((m) => (m as { text: string }).text)
const types = (out: unknown[]) => out.map((m) => (m as { t: string }).t)

describe('worker bootstrap', () => {
  it('takes away the network and everything that could reach another page', () => {
    const w = worker({
      source: `
        var names = ['fetch','XMLHttpRequest','WebSocket','importScripts','Worker','indexedDB','caches','BroadcastChannel','postMessage','setTimeout','setInterval','navigator','location','Notification'];
        irc.log(names.map(function (n) { return n + ':' + typeof self[n]; }).join(' '));
      `,
    })
    const line = logs(w.out)[0]!
    for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'Worker', 'indexedDB', 'caches', 'BroadcastChannel', 'postMessage', 'setTimeout', 'setInterval', 'navigator', 'location', 'Notification']) {
      expect(line).toContain(`${n}:undefined`)
    }
    expect(types(w.out)).toContain('ready')
  })

  it('also takes them off the objects the global inherits from, where browsers keep some', () => {
    const out: unknown[] = []
    const port = { postMessage: (m: unknown) => out.push(JSON.parse(JSON.stringify(m))), onmessage: null as null | ((e: { data: unknown }) => void) }
    const listeners: Array<(e: unknown) => void> = []
    const sandbox: Record<string, unknown> = {
      addEventListener: (_t: string, f: (e: unknown) => void) => listeners.push(f),
      removeEventListener: () => {},
    }
    sandbox.self = sandbox
    const ctx = vm.createContext(sandbox)
    // fetch and WebSocket sit on an object the global inherits from, not on the global itself.
    vm.runInContext('Object.setPrototypeOf(globalThis, { fetch: function () {}, WebSocket: function () {} })', ctx)
    vm.runInContext(BOOTSTRAP, ctx)
    listeners[0]!({ data: { t: 'port' }, ports: [port] })
    port.onmessage!({ data: { t: 'init', source: 'irc.log(typeof fetch, typeof self.fetch, typeof WebSocket)', info: { plugin: 'p', version: '1.0.0', nick: '', network: '', granted: [] }, storage: {} } })
    expect(logs(out)).toEqual(['undefined undefined undefined'])
  })

  it('reports ready when the code loads, and not-ready with the error when it does not', () => {
    expect(worker({ source: 'irc.log("x")' }).out.at(-1)).toEqual({ t: 'ready', ok: true })
    const bad = worker({ source: 'this is not javascript' })
    expect(bad.out.at(-1)).toEqual({ t: 'ready', ok: false })
    expect(bad.out.some((m) => (m as { t: string }).t === 'error')).toBe(true)
    const thrown = worker({ source: 'throw new Error("boom")' })
    expect(JSON.stringify(thrown.out)).toContain('boom')
  })

  it('gives the plugin an irc object it cannot change', () => {
    const w = worker({ source: `'use strict'; try { irc.send = null } catch (e) { irc.log("frozen") } try { irc.info.nick = "x" } catch (e) { irc.log("info frozen") } irc.log(irc.info.nick, irc.info.plugin)` })
    expect(logs(w.out)).toEqual(['frozen', 'info frozen', 'me p'])
  })

  it('refuses calls it was not granted, and says which permission', () => {
    const w = worker({ source: `['send','print','storage.get','on','setTimer'].forEach(function (what) { try { ({ send: function(){irc.send("x")}, print: function(){irc.print("x")}, 'storage.get': function(){irc.storage.get("k")}, on: function(){irc.on("TEXT", function(){})}, setTimer: function(){irc.setTimer(500, function(){})} })[what](); irc.log(what + ' allowed') } catch (e) { irc.log(what + ': ' + e.message) } })` })
    expect(logs(w.out)).toEqual([
      'send: permission "send" was not granted to this plugin',
      'print: permission "output" was not granted to this plugin',
      'storage.get: permission "storage" was not granted to this plugin',
      'on: permission "events" was not granted to this plugin',
      'setTimer: permission "timers" was not granted to this plugin',
    ])
    // Nothing that needs a permission was sent to the page.
    expect(types(w.out).filter((t) => ['send', 'print', 'store', 'on', 'timer'].includes(t))).toEqual([])
  })

  it('sends what the plugin asks for, in shapes the page accepts', () => {
    const w = worker({
      granted: ['send', 'output', 'storage', 'events', 'timers'],
      source: `
        irc.alias('Greet', function () {});
        irc.on('text', function () {});
        irc.send('hello', '#c'); irc.say('bob', 'hi'); irc.print('shown'); irc.print('there', '#c');
        irc.storage.set('k', {a: 1}); irc.storage.delete('k');
        var id = irc.setTimer(500, function () {}, true); irc.clearTimer(id);
        irc.log('a', 5, {});
      `,
    })
    const kinds = w.out.map((m) => parseFromWorker(m))
    expect(kinds.every((k) => k !== null)).toBe(true)
    expect(types(w.out)).toEqual(['alias', 'on', 'send', 'send', 'print', 'print', 'store', 'store', 'timer', 'clear', 'log', 'ready'])
    expect(w.out[0]).toEqual({ t: 'alias', name: 'greet' })
    expect(w.out[3]).toEqual({ t: 'send', line: '/msg bob hi', buffer: '', network: '' })
  })

  it('delivers events to handlers, one failing handler not stopping the next', () => {
    const w = worker({
      granted: ['events'],
      source: `irc.on('TEXT', function () { throw new Error('first fails') }); irc.on('TEXT', function (e) { irc.log('got ' + e.text + ' from ' + e.nick) })`,
    })
    w.out.length = 0
    w.to({ t: 'event', ev: { event: 'TEXT', text: 'hi', nick: 'bob' } })
    expect(logs(w.out)).toEqual(['got hi from bob'])
    expect(JSON.stringify(w.out)).toContain('first fails')
  })

  it('runs an alias with its arguments and context', () => {
    const w = worker({ source: `irc.alias('greet', function (args, ctx, raw) { irc.log(args.join('|'), ctx.buffer, raw) })` })
    w.out.length = 0
    w.to({ t: 'alias', name: 'greet', args: ['a', 'b'], raw: 'a b', ctx: { network: 'n', buffer: '#c', nick: 'me' } })
    expect(logs(w.out)).toEqual(['a|b #c a b'])
    w.to({ t: 'alias', name: 'unknown', args: [], raw: '', ctx: {} }) // ignored
  })

  it('fires timers once or repeatedly', () => {
    const w = worker({ granted: ['timers'], source: `var n = 0; irc.setTimer(100, function () { irc.log('once') }); irc.setTimer(100, function () { irc.log('again ' + (++n)) }, true)` })
    w.out.length = 0
    w.to({ t: 'fire', id: 1 }); w.to({ t: 'fire', id: 1 }); w.to({ t: 'fire', id: 2 }); w.to({ t: 'fire', id: 2 })
    expect(logs(w.out)).toEqual(['once', 'again 1', 'again 2'])
  })

  it('keeps stored data in step with what the page holds', () => {
    const w = worker({ granted: ['storage'], storage: { count: '5' }, source: `irc.log(String(irc.storage.get('count')), String(irc.storage.get('nope'))); irc.storage.set('count', irc.storage.get('count') + 1); irc.log(String(irc.storage.get('count')), irc.storage.keys().join(','))` })
    expect(logs(w.out)).toEqual(['5 undefined', '6 count'])
    expect(() => worker({ granted: ['storage'], source: `irc.storage.set('k', 'x'.repeat(9000))` }).out).not.toThrow()
    const big = worker({ granted: ['storage'], source: `try { irc.storage.set('k', 'x'.repeat(9000)) } catch (e) { irc.log(e.message) }` })
    expect(logs(big.out)[0]).toContain('at most 8000')
  })

  it('answers pings', () => {
    const w = worker({ source: '' + 'irc.log(1)' })
    w.to({ t: 'ping', n: 7 })
    expect(w.out.at(-1)).toEqual({ t: 'pong', n: 7 })
  })

  it('limits aliases', () => {
    const w = worker({ source: `var made = 0; try { for (var i = 0; i < 30; i++) { irc.alias('a' + i, function () {}); made++ } } catch (e) { irc.log(made + ' ' + e.message) }` })
    expect(logs(w.out)).toEqual(['20 too many aliases'])
  })

  it('stops listening for the port once it has it', () => {
    const w = worker({ source: 'irc.log(1)' })
    expect(w.listeners.length).toBe(0)
  })
})

describe('worker bootstrap dialogs', () => {
  const dialog = (w: ReturnType<typeof worker>) => w.out.find((m) => (m as { t: string }).t === 'dialog') as { id: number; kind: string; text: string; value: string }

  it('refuses without the permission, and says so', () => {
    const w = worker({ source: `try { irc.alert('x') } catch (e) { irc.log(e.message) }` })
    expect(logs(w.out)[0]).toMatch(/dialogs/)
    expect(types(w.out)).not.toContain('dialog')
  })

  it('asks the page for each kind of window and settles the promise with the answer', async () => {
    const w = worker({
      granted: ['dialogs'],
      source: `
        irc.alias('go', async function () {
          await irc.alert('hello');
          const yes = await irc.confirm('sure?');
          const name = await irc.prompt('name?', 'bob');
          irc.log(String(yes) + ' ' + String(name));
        });`,
    })
    w.to({ t: 'alias', name: 'go', args: [], raw: '', ctx: { network: '', buffer: '', nick: '' } })
    let d = dialog(w)
    expect(d).toMatchObject({ kind: 'alert', text: 'hello' })
    w.to({ t: 'answer', id: d.id, ok: true, value: '' })
    await new Promise((r) => setTimeout(r, 0))
    d = w.out.filter((m) => (m as { t: string }).t === 'dialog')[1] as typeof d
    expect(d).toMatchObject({ kind: 'confirm', text: 'sure?' })
    w.to({ t: 'answer', id: d.id, ok: true, value: '' })
    await new Promise((r) => setTimeout(r, 0))
    d = w.out.filter((m) => (m as { t: string }).t === 'dialog')[2] as typeof d
    expect(d).toMatchObject({ kind: 'prompt', text: 'name?', value: 'bob' })
    w.to({ t: 'answer', id: d.id, ok: true, value: 'alice' })
    await new Promise((r) => setTimeout(r, 0))
    expect(logs(w.out)).toEqual(['true alice'])
  })

  it('gives false for a declined confirm and null for a cancelled prompt', async () => {
    const w = worker({
      granted: ['dialogs'],
      source: `irc.alias('go', async function () { irc.log(String(await irc.confirm('a')), String(await irc.prompt('b'))) });`,
    })
    w.to({ t: 'alias', name: 'go', args: [], raw: '', ctx: { network: '', buffer: '', nick: '' } })
    w.to({ t: 'answer', id: dialog(w).id, ok: false, value: '' })
    await new Promise((r) => setTimeout(r, 0))
    w.to({ t: 'answer', id: (w.out.filter((m) => (m as { t: string }).t === 'dialog')[1] as { id: number }).id, ok: false, value: '' })
    await new Promise((r) => setTimeout(r, 0))
    expect(logs(w.out)).toEqual(['false null'])
  })

  it('ignores an answer to a window it did not open', () => {
    const w = worker({ granted: ['dialogs'], source: `irc.log('up')` })
    expect(() => w.to({ t: 'answer', id: 99, ok: true, value: 'x' })).not.toThrow()
  })
})
