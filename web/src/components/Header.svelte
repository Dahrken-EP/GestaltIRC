<script lang="ts">
  import { tokenize } from '../lib/render'
  import type { Buffer, NetworkState } from '../lib/network.svelte'
  import { settings } from '../lib/settings.svelte'
  import { t } from '../lib/i18n.svelte'
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
  <button class="icon menu" title={t('nav.show_channels')} aria-label={t('nav.show_channels')} onclick={onmenu}>☰</button>
  <h1>{buf.kind === 'status' ? net.label : buf.kind === 'p2p' ? `⚡ ${buf.title}` : buf.name}</h1>
  {#if buf.kind === 'channel' && buf.topic}
    <span class="topic" title={buf.topic}><TokenText tokens={topic} {onchannel} /></span>
  {:else if buf.kind === 'p2p'}
    <span class="topic">{t('header.direct_hint')}</span>
  {:else if buf.kind === 'status'}
    <span class="topic">{net.status === 'connected' ? t('header.connected_as', { nick: net.nick }) : net.statusDetail || net.status}</span>
  {/if}
  <span class="grow"></span>
  {#if buf.kind === 'query'}
    <button class="btn" title={t('button.direct_hint')} onclick={() => net.openDirect(buf.name)}>{t('button.direct')}</button>
    {#if net.canVoice}
      <button class="btn" title={t('button.call_hint')} onclick={() => net.callNick(buf.name)}>{t('button.call')}</button>
    {/if}
  {/if}
  <button class="icon" title={t('button.search_title')} aria-label={t('search.aria')} onclick={onsearch}>🔍</button>
  {#if buf.kind === 'channel'}
    <button
      class="icon"
      class:on={settings.showMembers}
      title={t('button.toggle_members')}
      aria-label={t('button.toggle_members')}
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
