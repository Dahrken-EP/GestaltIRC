<script lang="ts">
  import { nickColor } from '../lib/nickcolor'
  import type { Buffer, NetworkState } from '../lib/network.svelte'
  import { settings } from '../lib/settings.svelte'

  let { net, buf, onnick }: { net: NetworkState; buf: Buffer; onnick: (nick: string) => void } = $props()

  // The menu opened with a right-click (or the menu key, or a long press) on someone.
  let menu = $state<{ nick: string; x: number; y: number } | null>(null)
  let menuEl: HTMLDivElement | undefined = $state()

  /** Whether we can op, kick and ban here: anyone with a prefix above voice. */
  const canModerate = $derived.by(() => {
    void buf.membersRev
    const mine = buf.members.get(net.nick.toLowerCase())?.prefix[0]
    return !!mine && mine !== net.prefixSymbols.at(-1)
  })

  function open(e: MouseEvent, nick: string) {
    e.preventDefault()
    // From the keyboard the event has no position, so use the button's.
    const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : (() => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      return { x: r.left, y: r.bottom }
    })()
    menu = { nick, ...at }
  }

  function run(cmd: string) {
    menu = null
    net.submit(cmd)
  }

  function copyNick(nick: string) {
    menu = null
    void navigator.clipboard?.writeText(nick).catch(() => {})
  }

  const isSelf = (nick: string) => nick.toLowerCase() === net.nick.toLowerCase()

  // Keep the menu on screen, and put focus in it.
  const left = $derived(Math.max(4, Math.min(menu?.x ?? 0, (typeof innerWidth === 'number' ? innerWidth : 800) - 214)))
  const top = $derived(Math.max(4, Math.min(menu?.y ?? 0, (typeof innerHeight === 'number' ? innerHeight : 600) - 330)))
  $effect(() => {
    if (menu) queueMicrotask(() => menuEl?.querySelector<HTMLElement>('[role=menuitem]')?.focus())
  })

  function menuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      menu = null
      return
    }
    const items = [...(menuEl?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus()
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus()
    else return
    e.preventDefault()
  }

  // Highest prefix first, then alphabetical.
  const rank = (prefix: string) => {
    const i = prefix ? net.prefixSymbols.indexOf(prefix[0]!) : -1
    return i < 0 ? 99 : i
  }
  const sorted = $derived.by(() => {
    void buf.membersRev
    return [...buf.members.values()].sort(
      (a, b) => rank(a.prefix) - rank(b.prefix) || a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }),
    )
  })
</script>

<aside class="members" aria-label="Members of {buf.name}">
  <h3>{sorted.length} {sorted.length === 1 ? 'member' : 'members'}</h3>
  <ul>
    {#each sorted as m (m.nick)}
      <li>
        <button
          class:away={m.away}
          onclick={() => onnick(m.nick)}
          oncontextmenu={(e) => open(e, m.nick)}
          aria-haspopup="menu"
          title={m.away ? `${m.nick} (away)` : m.nick}
        >
          <span class="prefix">{m.prefix[0] ?? ''}</span><span class="n" style:color={nickColor(m.nick, settings.nickColors)}>{m.nick}</span>
        </button>
      </li>
    {/each}
  </ul>
</aside>

{#if menu}
  {@const nick = menu.nick}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (menu = null)} oncontextmenu={(e) => (e.preventDefault(), (menu = null))}>
    <div
      class="menu"
      role="menu"
      tabindex="-1"
      aria-label="Actions for {nick}"
      data-testid="user-menu"
      bind:this={menuEl}
      style:left="{left}px"
      style:top="{top}px"
      onclick={(e) => e.stopPropagation()}
      onkeydown={menuKey}
    >
      <div class="title"><strong>{nick}</strong></div>
      {#if !isSelf(nick)}
        <button role="menuitem" onclick={() => ((menu = null), onnick(nick))}>Message</button>
        <button role="menuitem" onclick={() => run(`/direct ${nick}`)}>Direct chat</button>
        <button role="menuitem" onclick={() => run(`/call ${nick}`)}>Voice call</button>
      {/if}
      <button role="menuitem" onclick={() => run(`/whois ${nick}`)}>Who is…</button>
      <button role="menuitem" onclick={() => run(`/ctcp ${nick} VERSION`)}>Client version</button>
      <button role="menuitem" onclick={() => copyNick(nick)}>Copy nick</button>
      {#if canModerate && !isSelf(nick)}
        <hr />
        <button role="menuitem" onclick={() => run(`/mode +o ${nick}`)}>Give operator</button>
        <button role="menuitem" onclick={() => run(`/mode -o ${nick}`)}>Take operator</button>
        <button role="menuitem" onclick={() => run(`/mode +v ${nick}`)}>Give voice</button>
        <button role="menuitem" onclick={() => run(`/mode -v ${nick}`)}>Take voice</button>
        <hr />
        <button role="menuitem" onclick={() => run(`/kick ${nick}`)}>Kick</button>
        <button role="menuitem" class="danger" onclick={() => run(`/ban ${nick}\n/kick ${nick}`)}>Ban and kick</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 25;
  }
  .menu {
    position: fixed;
    width: 210px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  }
  .menu .title {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .menu button {
    padding: 5px 8px;
    border-radius: 5px;
    text-align: left;
    white-space: normal;
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--bg-hover);
  }
  .menu .danger {
    color: var(--danger, #d44);
  }
  .menu hr {
    width: 100%;
    margin: 4px 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .members {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
  }
  h3 {
    margin: 0;
    padding: 8px 10px;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-dim);
    position: sticky;
    top: 0;
    background: var(--bg-panel);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 4px 8px;
  }
  button {
    display: flex;
    width: 100%;
    padding: 0 6px;
    border-radius: 4px;
    text-align: left;
    white-space: nowrap;
  }
  button:hover {
    background: var(--bg-hover);
  }
  button.away {
    opacity: 0.5;
  }
  .prefix {
    width: 1.1em;
    flex: none;
    color: var(--fg-dim);
    font-weight: 700;
  }
  .n {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
