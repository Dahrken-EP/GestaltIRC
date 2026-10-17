// The plugins the user has installed, which of them are running, and the glue to the chat:
// events go out to the running plugins, and what a plugin sends or prints comes back in.

import { BUILTIN_COMMANDS } from '../commands'
import type { Buffer, NetworkState, PluginBus } from '../network.svelte'
import { PluginInstance, type SandboxFactory, type Status } from './host'
import { parseBundle, parseStored } from './manifest'
import { createSandbox } from './sandbox'
import { deleteData, loadData, loadPlugins, loadStamp, saveData, savePlugins, saveStamp } from './store'
import type { DialogAnswer, DialogRequest, EventName, InstalledPlugin, Permission, PluginEvent } from './types'

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

/** A window a plugin has asked for, waiting for the user or already on screen. */
export interface PendingDialog extends DialogRequest {
  id: number
  plugin: string
}

const MAX_LOG = 200
const MAX_PLUGINS = 20

/** Everything about the installed plugins that is kept on the bouncer, so it follows the account. */
export interface PluginDoc {
  /** When it was last changed, in milliseconds. The newer copy wins when a browser and the bouncer disagree. */
  updated: number
  plugins: InstalledPlugin[]
  data: Record<string, Record<string, string>>
}

/** Where the plugin document lives. `load` gives null when nothing was saved yet. */
export interface PluginRemote {
  load(): Promise<Record<string, unknown> | null>
  save(doc: PluginDoc): Promise<void>
}

/** Several quick changes (a plugin counting mentions, say) become one upload. */
const UPLOAD_DELAY_MS = 1500

export interface Env {
  /** The network with this name, if there is one. */
  network(label: string): NetworkState | undefined
  /** The network on screen. */
  active(): NetworkState | undefined
}

class PluginManager implements PluginBus {
  entries = $state.raw<PluginEntry[]>([])
  /** The windows plugins have asked for, oldest first. The first is the one on screen. */
  dialogs = $state.raw<PendingDialog[]>([])
  private answers = new Map<number, (a: DialogAnswer) => void>()
  private dialogId = 0

  private user = ''
  private list: InstalledPlugin[] = []
  private instances = new Map<string, PluginInstance>()
  private logs = new Map<string, PluginLog[]>()
  /** The network a plugin was last woken by, which is where its output goes unless it names another. */
  private lastNetwork = new Map<string, string>()
  private env: Env = { network: () => undefined, active: () => undefined }
  makeSandbox: SandboxFactory = createSandbox
  private remote: PluginRemote | null = null
  /** True once the bouncer's copy has been read, so a stale local copy cannot overwrite it. */
  private synced = false
  private uploadTimer: ReturnType<typeof setTimeout> | undefined
  private uploadWanted = false
  /** When the plugins or their data last changed here. */
  private stamp = 0

  /** Called once the user is logged in. Starts the plugins that are switched on. */
  init(user: string, env: Env, remote: PluginRemote | null = null): void {
    this.dispose()
    this.user = user
    this.env = env
    this.remote = remote
    this.list = loadPlugins(user)
    this.stamp = loadStamp(user)
    for (const p of this.list) if (p.enabled) this.run(p)
    this.refresh()
    if (remote) void this.sync(user, remote)
  }

  /**
   * Reconciles with the bouncer. What it holds replaces what this browser has, so plugins follow the
   * account; when it holds nothing yet, this browser's plugins are uploaded, so existing ones carry over.
   * If the bouncer cannot be reached, local plugins keep working and nothing is uploaded.
   */
  private async sync(user: string, remote: PluginRemote): Promise<void> {
    let doc: Record<string, unknown> | null
    try {
      doc = await remote.load()
    } catch {
      return
    }
    if (this.user !== user) return // logged out, or another account, while waiting
    this.synced = true
    if (doc === null) {
      if (this.list.length > 0 || this.uploadWanted) this.scheduleUpload()
      return
    }
    // Whichever copy changed last is the one to keep: a change made here a moment before the page was closed may
    // not have reached the bouncer, and must not be undone by what is there.
    const remoteStamp = typeof doc.updated === 'number' ? doc.updated : 0
    if (this.stamp > remoteStamp) {
      this.scheduleUpload()
      return
    }
    const remoteList: InstalledPlugin[] = []
    for (const item of Array.isArray(doc.plugins) ? doc.plugins : []) {
      const p = parseStored(item)
      if (p && !remoteList.some((o) => o.manifest.name === p.manifest.name)) remoteList.push(p)
    }
    const data = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? (doc.data as Record<string, unknown>) : {}
    for (const i of this.instances.values()) i.stop()
    this.instances.clear()
    for (const old of this.list) deleteData(user, old.manifest.name)
    this.list = remoteList.slice(0, MAX_PLUGINS)
    this.stamp = remoteStamp
    saveStamp(user, this.stamp)
    savePlugins(user, this.list)
    for (const p of this.list) {
      const d = data[p.manifest.name]
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const clean: Record<string, string> = {}
        for (const [k, v] of Object.entries(d)) if (typeof v === 'string') clean[k] = v
        saveData(user, p.manifest.name, clean)
      }
    }
    for (const p of this.list) if (p.enabled) this.run(p)
    this.refresh()
  }

  /** Records that something changed here, and arranges for the bouncer to be told. */
  private changed(): void {
    this.stamp = Date.now()
    saveStamp(this.user, this.stamp)
    this.scheduleUpload()
  }

  /** Sends any change that is still waiting, now. For when the page is about to close. */
  flush(): void {
    if (!this.uploadWanted || !this.synced) return
    clearTimeout(this.uploadTimer)
    void this.upload()
  }

  private scheduleUpload(): void {
    if (!this.remote) return
    this.uploadWanted = true
    if (!this.synced) return // sync() uploads once it has seen what the bouncer has
    clearTimeout(this.uploadTimer)
    this.uploadTimer = setTimeout(() => void this.upload(), UPLOAD_DELAY_MS)
  }

  private async upload(): Promise<void> {
    const remote = this.remote
    if (!remote || !this.synced) return
    this.uploadWanted = false
    const data: PluginDoc['data'] = {}
    for (const p of this.list) data[p.manifest.name] = loadData(this.user, p.manifest.name)
    try {
      await remote.save({ updated: this.stamp, plugins: this.list.map((p) => ({ ...p })), data })
    } catch {
      this.uploadWanted = true // tried again with the next change
    }
  }

  /** Stops everything, as at logout. */
  dispose(): void {
    clearTimeout(this.uploadTimer)
    this.remote = null
    this.synced = false
    this.uploadWanted = false
    this.stamp = 0
    for (const i of this.instances.values()) i.stop()
    this.instances.clear()
    this.logs.clear()
    this.lastNetwork.clear()
    this.list = []
    this.user = ''
    this.entries = []
    this.closeDialogs(() => true)
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

  // --- windows plugins open ---

  private ask(plugin: string, req: DialogRequest): Promise<DialogAnswer> {
    return new Promise((resolve) => {
      const id = ++this.dialogId
      this.answers.set(id, resolve)
      this.dialogs = [...this.dialogs, { ...req, id, plugin }]
    })
  }

  /** What the user did with the window on screen. */
  answerDialog(id: number, a: DialogAnswer): void {
    const resolve = this.answers.get(id)
    this.answers.delete(id)
    this.dialogs = this.dialogs.filter((d) => d.id !== id)
    resolve?.(a)
  }

  /** The user chose to stop the plugin that opened this window. */
  stopFromDialog(id: number): void {
    const d = this.dialogs.find((x) => x.id === id)
    if (!d) return
    this.log(d.plugin, 'info', 'You stopped it from one of its windows.')
    this.setEnabled(d.plugin, false)
  }

  private closeDialogs(which: (d: PendingDialog) => boolean): void {
    for (const d of this.dialogs.filter(which)) {
      this.answers.get(d.id)?.({ ok: false, value: '' })
      this.answers.delete(d.id)
    }
    this.dialogs = this.dialogs.filter((d) => !which(d))
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
        saveStorage: (all) => {
          void saveData(this.user, name, all)
          this.changed()
        },
        ask: (req) => this.ask(name, req),
        closeDialogs: () => this.closeDialogs((d) => d.plugin === name),
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
    this.changed()
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
