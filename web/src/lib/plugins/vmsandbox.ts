// For tests only: a sandbox that runs the real bootstrap and plugin code in a Node vm context
// instead of a browser worker, with the dangerous globals present so that removing them can be
// checked. Messages cross as JSON copies, as they do between a page and a worker.

// The tests run on Node. The browser build has no Node types, and nothing in the page imports this file.
// @ts-expect-error no @types/node
import vm from 'node:vm'
import { BOOTSTRAP } from './bootstrap'
import type { SandboxFactory } from './host'

export const vmSandbox: SandboxFactory = ({ message }) => {
  const listeners: Array<(e: unknown) => void> = []
  const toHost = (m: unknown) => queueMicrotask(() => message(JSON.parse(JSON.stringify(m))))
  const port = { postMessage: toHost, onmessage: null as null | ((e: { data: unknown }) => void) }
  const sandbox: Record<string, unknown> = {
    fetch: () => 'network!', XMLHttpRequest: class {}, WebSocket: class {}, importScripts: () => 0, Worker: class {},
    indexedDB: {}, caches: {}, BroadcastChannel: class {}, postMessage: () => 'escaped!', setTimeout: () => 0, setInterval: () => 0,
    navigator: { userAgent: 'x' }, location: { href: 'blob:null/x' }, Notification: class {},
    addEventListener: (_t: string, f: (e: unknown) => void) => listeners.push(f),
    removeEventListener: (_t: string, f: (e: unknown) => void) => {
      const i = listeners.indexOf(f)
      if (i >= 0) listeners.splice(i, 1)
    },
  }
  sandbox.self = sandbox
  vm.runInContext(BOOTSTRAP, vm.createContext(sandbox))
  listeners[0]!({ data: { t: 'port' }, ports: [port] })
  let alive = true
  return {
    post: (m) => {
      if (alive) queueMicrotask(() => alive && port.onmessage?.({ data: JSON.parse(JSON.stringify(m)) }))
    },
    terminate: () => {
      alive = false
    },
  }
}
