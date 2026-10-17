<script lang="ts">
  import { app } from '../lib/app.svelte'

  const initials = (label: string) => label.slice(0, 2).toUpperCase()
</script>

<nav class="rail" aria-label="Networks">
  {#each app.networks as net (net.id)}
    <button
      class="net"
      class:active={net.id === app.activeId}
      class:offline={net.status !== 'connected'}
      title="{net.label} ({net.status})"
      aria-label="{net.label}, {net.status}{net.unread ? `, ${net.unread} unread` : ''}"
      aria-current={net.id === app.activeId ? 'true' : undefined}
      onclick={() => app.activate(net.id)}
    >
      {initials(net.label)}
      {#if net.mentionCount}
        <span class="badge mention">{net.mentionCount}</span>
      {:else if net.unread}
        <span class="dot" aria-hidden="true"></span>
      {/if}
    </button>
  {/each}
  <button class="net add" title="Add network" aria-label="Add network" onclick={() => (app.showLogin = true)}>+</button>
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
  .net.offline:not(.add) {
    opacity: 0.55;
  }
  .add {
    font-size: 18px;
    font-weight: 400;
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
