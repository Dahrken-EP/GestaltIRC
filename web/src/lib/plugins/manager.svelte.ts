// The plugins the user has installed, which of them are running, and the glue to the chat:
// events go out to the running plugins, and what a plugin sends or prints comes back in.

import { BUILTIN_COMMANDS } from '../commands'
import type { Buffer, NetworkState, PluginBus } from '../network.svelte'
import { PluginInstance, type SandboxFactory, type Status } from './host'
import { parseBundle } from './manifest'
import { createSandbox } from './sandbox'
import { deleteData, loadData, loadPlugins, saveData, savePlugins } from './store'
import type { EventName, InstalledPlugin, Permission, PluginEvent } from './types'

export interface PluginLog {
  time: number
  kind: 'log' | 'error' | 'info'
  text: string
}

export interface PluginEntry {
  plugin: InstalledPlugin
  status: Status
  error: string
  aliases: string[]
  events: EventName[]
  logs: PluginLog[]
}

const MAX_LOG = 200
const MAX_PLUGINS = 20

export interface Env {
  /** The network with this name, if there is one. */
  network(label: string): NetworkState | undefined
  /** The network on screen. */
  active(): NetworkState | undefined
}

class PluginManager implements PluginBus {
  entries = $state.raw<PluginEntry[]>([])

  private user = ''
  private list: InstalledPlugin[] = []
  private instances = new Map<string, PluginInstance>()
  private logs = new Map<string, PluginLog[]>()
  /** The network a plugin was last woken by, which is where its output goes unless it names another. */
  private lastNetwork = new Map<string, string>()
  private env: Env = { network: () => undefined, active: () => undefined }
  makeSandbox: SandboxFactory = createSandbox

  /** Called once the user is logged in. Starts the plugins that are switched on. */
  init(user: string, env: Env): void {
    this.dispose()
    this.user = user
    this.env = env
    this.list = loadPlugins(user)
    for (const p of this.list) if (p.enabled) this.run(p)
    this.refresh()
  }

  /** Stops everything, as at logout. */
  dispose(): void {
    for (const i of this.instances.values()) i.stop()
    this.instances.clear()
    this.logs.clear()
    this.lastNetwork.clear()
    this.list = []
    this.user = ''
    this.entries = []
  }

  // --- installing ---

  /** Installs (or replaces) a plugin with the permissions the user agreed to. */
  install(text: string, granted: Permission[]): { ok: true; name: string } | { ok: false; error: string } {
    const r = parseBundle(text)
    if (!r.ok) return r
    const name = r.plugin.manifest.name
    if (!this.list.some((p) => p.manifest.name === name) && this.list.length >= MAX_PLUGINS) {
      return { ok: false, error: `At most ${MAX_PLUGINS} plugins can be installed.` }
    }
    const allowed = granted.filter((p) => r.plugin.manifest.permissions.includes(p))
    const plugin: InstalledPlugin = { ...r.plugin, granted: [...new Set(allowed)], enabled: true }
    this.instances.get(name)?.stop()
    this.instances.delete(name)
    this.list = [...this.list.filter((p) => p.manifest.name !== name), plugin]
    this.logs.set(name, [])
    this.persist()
    this.run(plugin)
    this.refresh()
    return { ok: true, name }
  }

  remove(name: string): void {
    this.instances.get(name)?.stop()
    this.instances.delete(name)
    this.logs.delete(name)
    this.lastNetwork.delete(name)
    this.list = this.list.filter((p) => p.manifest.name !== name)
    deleteData(this.user, name)
    this.persist()
    this.refresh()
  }

  setEnabled(name: string, on: boolean): void {
    const p = this.list.find((x) => x.manifest.name === name)
    if (!p) return
    p.enabled = on
    this.persist()
    if (on) this.run(p)
    else {
      this.instances.get(name)?.stop()
      this.instances.delete(name)
    }
    this.refresh()
  }

  // --- the chat's side ---

  emit(ev: PluginEvent): void {
    for (const [name, inst] of this.instances) {
      if (inst.status !== 'running' || !inst.subscriptions.includes(ev.event)) continue
      this.lastNetwork.set(name, ev.network)
      inst.dispatch(ev)
    }
  }

  alias(net: NetworkState, buf: Buffer, name: string, args: string[], raw: string): boolean {
    for (const [plugin, inst] of this.instances) {
      if (!inst.aliasNames.includes(name)) continue
      this.lastNetwork.set(plugin, net.label)
      return inst.runAlias(name, args, raw, { network: net.label, buffer: buf.kind === 'status' ? '' : buf.name, nick: net.nick })
    }
    return false
  }

  // --- internals ---

  private run(plugin: InstalledPlugin): void {
    const name = plugin.manifest.name
    const where = (label: string) => (label ? this.env.network(label) : undefined) ?? this.env.network(this.lastNetwork.get(name) ?? '') ?? this.env.active()
    const inst = new PluginInstance(
      plugin,
      {
        context: () => {
          const net = where('')
          return { nick: net?.nick ?? '', network: net?.label ?? '' }
        },
        send: (line, buffer, network) => where(network)?.submitTo(buffer, line),
        print: (text, buffer, network) => {
          const net = where(network)
          if (!net) return
          net.local((buffer && net.find(buffer)) || net.active, 'info', `[${name}] ${text}`)
        },
        loadStorage: () => loadData(this.user, name),
        saveStorage: (all) => void saveData(this.user, name, all),
        isBuiltin: (n) => BUILTIN_COMMANDS.has(n),
        log: (text, kind) => this.log(name, kind, text),
        onStop: (reason) => {
          // Switched off, so a plugin that fails every time does not do so on every load.
          const p = this.list.find((x) => x.manifest.name === name)
          if (p) p.enabled = false
          this.persist()
          this.log(name, 'error', `Stopped: ${reason}`)
          this.refresh()
        },
        changed: () => this.refresh(),
      },
      this.makeSandbox,
    )
    this.instances.set(name, inst)
    inst.start()
  }

  private log(name: string, kind: PluginLog['kind'], text: string): void {
    const lines = [...(this.logs.get(name) ?? []), { time: Date.now(), kind, text }]
    this.logs.set(name, lines.slice(-MAX_LOG))
    this.refresh()
  }

  private persist(): void {
    savePlugins(this.user, this.list)
  }

  private refresh(): void {
    this.entries = this.list.map((plugin): PluginEntry => {
      const inst = this.instances.get(plugin.manifest.name)
      return {
        plugin: { ...plugin },
        status: inst?.status ?? 'stopped',
        error: inst?.error ?? '',
        aliases: inst?.aliasNames ?? [],
        events: inst?.subscriptions ?? [],
        logs: this.logs.get(plugin.manifest.name) ?? [],
      }
    })
  }
}

export const plugins = new PluginManager()
export { PluginManager }
