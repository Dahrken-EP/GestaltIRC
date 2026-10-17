<script lang="ts">
  import { app } from '../lib/app.svelte'
  import type { NetworkState } from '../lib/network.svelte'

  let { net, onpick }: { net: NetworkState; onpick?: () => void } = $props()

  const channels = $derived(net.buffers.filter((b) => b.kind === 'channel'))
  const queries = $derived(net.buffers.filter((b) => b.kind === 'query'))
  const directs = $derived(net.buffers.filter((b) => b.kind === 'p2p'))

  function pick(key: string) {
    net.select(key)
    onpick?.()
  }
</script>

{#snippet item(key: string, label: string, unread: number, mentions: number, dim: boolean, closable: boolean, buf?: import('../lib/network.svelte').Buffer)}
  <li>
    <div class="row" class:active={net.activeKey === key} class:unread={unread > 0} class:dim>
      <button class="name" onclick={() => pick(key)} aria-current={net.activeKey === key ? 'true' : undefined}>
        <span class="label">{label}</span>
        {#if mentions}<span class="badge mention">{mentions}</span>{:else if unread}<span class="badge">{unread}</span>{/if}
      </button>
      {#if closable && buf}
        <button class="close" title="Close {label}" aria-label="Close {label}" onclick={() => net.closeBuffer(buf)}>×</button>
      {/if}
    </div>
  </li>
{/snippet}

<aside class="list" aria-label="Channels and queries">
  <header>
    <span class="netname" title={net.statusDetail || net.status}>
      <span class="status {net.status}" aria-hidden="true"></span>{net.label}
    </span>
    <button
      class="more"
      title="Server menu: edit, switch off, remove"
      aria-label="Server menu"
      aria-haspopup="menu"
      onclick={(e) => {
        const box = e.currentTarget.getBoundingClientRect()
        app.openServerMenu(net.name, box.left - 150, box.bottom + 4)
      }}>⋯</button
    >
  </header>

  <ul>
    {@render item('', 'Status', net.statusBuffer.unread, net.statusBuffer.mentionCount, false, false)}
  </ul>

  {#if channels.length}
    <h3>Channels</h3>
    <ul>
      {#each channels as b (b.key)}
        {@render item(b.key, (b.voice?.state === 'active' ? '🎙 ' : '') + b.name, b.unread, b.mentionCount, !b.joined, true, b)}
      {/each}
    </ul>
  {/if}

  {#if queries.length}
    <h3>Messages</h3>
    <ul>
      {#each queries as b (b.key)}
        {@render item(b.key, b.name, b.unread, b.mentionCount, false, true, b)}
      {/each}
    </ul>
  {/if}
  {#if directs.length}
    <h3>Direct</h3>
    <ul>
      {#each directs as b (b.key)}
        {@render item(b.key, (b.call?.state === 'connected' ? '📞 ' : '⚡ ') + b.name, b.unread, b.mentionCount, b.p2p?.state !== 'connected' && b.call?.state !== 'connected', true, b)}
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .list {
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    height: 100%;
    overflow-y: auto;
    width: 220px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    font-weight: 700;
    position: sticky;
    top: 0;
    background: var(--bg-panel);
  }
  .netname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    background: none;
    border: 0;
    color: var(--fg-dim);
    font-size: 1.2em;
    line-height: 1;
    padding: 0 4px;
    cursor: pointer;
  }
  .more:hover {
    color: var(--fg);
  }
  .status {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    background: var(--warn);
  }
  .status.connected {
    background: var(--ok);
  }
  .status.failed {
    background: var(--danger);
  }
  h3 {
    margin: 10px 10px 2px;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-dim);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 2px 4px;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: 4px;
    color: var(--fg-dim);
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.active {
    background: var(--bg-active);
    color: var(--fg);
  }
  .row.unread {
    color: var(--fg);
    font-weight: 700;
  }
  .row.dim .label {
    opacity: 0.5;
    font-style: italic;
  }
  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    text-align: left;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close {
    padding: 0 6px;
    color: var(--fg-dim);
    visibility: hidden;
  }
  .row:hover .close,
  .close:focus-visible {
    visibility: visible;
  }
  .close:hover {
    color: var(--danger);
  }
</style>
