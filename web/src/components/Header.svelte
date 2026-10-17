<script lang="ts">
  import { tokenize } from '../lib/render'
  import type { Buffer, NetworkState } from '../lib/network.svelte'
  import { settings } from '../lib/settings.svelte'
  import TokenText from './TokenText.svelte'

  let { net, buf, onmenu, onchannel, onsearch }: {
    net: NetworkState
    buf: Buffer
    onmenu: () => void
    onchannel: (name: string) => void
    onsearch: () => void
  } = $props()

  const topic = $derived(tokenize(buf.topic))
</script>

<header class="bar">
  <button class="icon menu" title="Show channels" aria-label="Show channels" onclick={onmenu}>☰</button>
  <h1>{buf.kind === 'status' ? net.label : buf.kind === 'p2p' ? `⚡ ${buf.name}` : buf.name}</h1>
  {#if buf.kind === 'channel' && buf.topic}
    <span class="topic" title={buf.topic}><TokenText tokens={topic} {onchannel} /></span>
  {:else if buf.kind === 'p2p'}
    <span class="topic">Direct chat, browser to browser</span>
  {:else if buf.kind === 'status'}
    <span class="topic">{net.status === 'connected' ? `Connected as ${net.nick}` : net.statusDetail || net.status}</span>
  {/if}
  <span class="grow"></span>
  {#if buf.kind === 'query'}
    <button class="btn" title="Chat straight between your browser and theirs" onclick={() => net.openDirect(buf.name)}>⚡ Direct chat</button>
    {#if net.canVoice}
      <button class="btn" title="Ring them for a private voice call" onclick={() => net.callNick(buf.name)}>📞 Call</button>
    {/if}
  {/if}
  <button class="icon" title="Search this conversation (Ctrl+F)" aria-label="Search this conversation" onclick={onsearch}>🔍</button>
  {#if buf.kind === 'channel'}
    <button
      class="icon"
      class:on={settings.showMembers}
      title="Toggle member list"
      aria-label="Toggle member list"
      aria-pressed={settings.showMembers}
      onclick={() => { settings.showMembers = !settings.showMembers; settings.save() }}>👥</button
    >
  {/if}
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    min-height: 36px;
  }
  h1 {
    margin: 0;
    font-size: 1em;
    white-space: nowrap;
  }
  .topic {
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .grow {
    flex: 1;
  }
  .icon {
    opacity: 0.7;
    padding: 2px 4px;
  }
  .icon.on,
  .icon:hover {
    opacity: 1;
  }
  .menu {
    display: none;
  }
  @media (max-width: 720px) {
    .menu {
      display: block;
    }
  }
</style>
