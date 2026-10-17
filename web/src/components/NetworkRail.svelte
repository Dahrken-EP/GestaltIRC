<script lang="ts">
  import { app } from '../lib/app.svelte'

  const initials = (label: string) => label.slice(0, 2).toUpperCase()

  /** Opens the server menu beside the button that was pressed. */
  function menu(name: string, e: MouseEvent) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    app.openServerMenu(name, box.right + 6, box.top)
  }
</script>

<nav class="rail" aria-label="Networks">
  {#each app.configured as info (info.name)}
    {@const net = app.networks.find((n) => n.name === info.name)}
    {#if net}
      <button
        class="net"
        class:active={net.id === app.activeId}
        class:offline={net.status !== 'connected'}
        title="{net.label} ({net.status}). {net.id === app.activeId ? 'Click for the server menu.' : ''}"
        aria-label="{net.label}, {net.status}{net.unread ? `, ${net.unread} unread` : ''}"
        aria-current={net.id === app.activeId ? 'true' : undefined}
        aria-haspopup="menu"
        data-server={info.name}
        onclick={(e) => (net.id === app.activeId ? menu(info.name, e) : app.activate(net.id))}
        oncontextmenu={(e) => (e.preventDefault(), menu(info.name, e))}
      >
        {initials(net.label)}
        {#if net.mentionCount}
          <span class="badge mention">{net.mentionCount}</span>
        {:else if net.unread}
          <span class="dot" aria-hidden="true"></span>
        {/if}
      </button>
    {:else}
      <button
        class="net off"
        title="{info.name} (switched off)"
        aria-label="{info.name}, switched off"
        aria-haspopup="menu"
        data-server={info.name}
        onclick={(e) => menu(info.name, e)}
        oncontextmenu={(e) => (e.preventDefault(), menu(info.name, e))}
      >
        {initials(info.name)}
      </button>
    {/if}
  {/each}
  <button class="net plus" title="Add a server" aria-label="Add a server" onclick={() => app.openServerDialog()}>+</button>
  <span class="grow"></span>
  <button class="net add" title="Settings" aria-label="Settings" onclick={() => (app.showSettings = true)}>⚙</button>
</nav>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    padding: 8px 0;
    background: var(--bg-rail);
    border-right: 1px solid var(--border);
    width: 52px;
    height: 100%;
  }
  .grow {
    flex: 1;
  }
  .net {
    position: relative;
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: var(--bg-panel);
    font-weight: 700;
    font-size: 12px;
    border: 1px solid var(--border);
  }
  .net:hover {
    border-radius: 8px;
    background: var(--bg-hover);
  }
  .net.active {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
    border-radius: 8px;
  }
  .net.offline:not(.add):not(.plus),
  .net.off {
    opacity: 0.55;
  }
  .net.off {
    border-style: dashed;
  }
  .add,
  .plus {
    font-size: 18px;
    font-weight: 400;
  }
  .plus {
    border-style: dashed;
    background: transparent;
    color: var(--fg-dim);
  }
  .plus:hover {
    color: var(--fg);
  }
  .badge {
    position: absolute;
    right: -4px;
    bottom: -4px;
  }
  .dot {
    position: absolute;
    right: -2px;
    top: -2px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--fg);
    border: 2px solid var(--bg-rail);
  }
</style>
