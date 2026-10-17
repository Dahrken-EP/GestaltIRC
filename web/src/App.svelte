<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from './lib/app.svelte'
  import { settings } from './lib/settings.svelte'
  import BufferList from './components/BufferList.svelte'
  import Header from './components/Header.svelte'
  import InputBar from './components/InputBar.svelte'
  import Login from './components/Login.svelte'
  import MemberList from './components/MemberList.svelte'
  import MessagePane from './components/MessagePane.svelte'
  import NetworkRail from './components/NetworkRail.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'

  import type { ChatMessage } from './lib/network.svelte'

  const net = $derived(app.active)
  const buf = $derived(net?.active)
  let navOpen = $state(false)
  /** The message the user chose to reply to. It belongs to one buffer, so switching drops it. */
  let reply = $state<ChatMessage | null>(null)
  $effect(() => {
    void buf?.key
    void net?.id
    reply = null
  })

  onMount(() => void app.init())

  // Theme and density are attributes on <html>, so the CSS variables switch together.
  $effect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.dataset.theme = settings.theme
    root.dataset.density = settings.density
  })

  // Unread count in the tab title.
  $effect(() => {
    const n = app.unread
    const m = app.mentionCount
    document.title = m ? `(${m}) ● IRC` : n ? `(${n}) IRC` : 'IRC'
  })

  // Reading position: coming back to the tab counts as reading the open buffer.
  function onfocus() {
    net?.markActiveRead()
  }

  function openNick(nick: string) {
    net?.openQuery(nick)
  }

  function openChannel(name: string) {
    if (!net) return
    const existing = net.find(name)
    if (existing) net.select(existing.key)
    else net.submit(`/join ${name}`)
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      app.step(e.key === 'ArrowDown' ? 1 : -1)
    }
  }
</script>

<svelte:window onfocus={onfocus} {onkeydown} />

{#if app.phase === 'loading'}
  <div class="splash" role="status">Loading…</div>
{:else if app.phase === 'login'}
  <Login />
{:else}
<div class="app" class:nav-open={navOpen}>
  <NetworkRail />
  {#if net && buf}
    <div class="nav"><BufferList {net} onpick={() => (navOpen = false)} /></div>
    <main>
      <Header {net} {buf} onmenu={() => (navOpen = !navOpen)} onchannel={openChannel} />
      <div class="body">
        <div class="messages">
          {#key net.id + '/' + buf.key}
            <MessagePane {net} {buf} onnick={openNick} onchannel={openChannel} onreply={(m) => (reply = m)} />
          {/key}
        </div>
        {#if buf.kind === 'channel' && settings.showMembers}
          <div class="members"><MemberList {net} {buf} onnick={openNick} /></div>
        {/if}
      </div>
      <InputBar {net} {buf} {reply} oncancelreply={() => (reply = null)} />
    </main>
  {:else}
    <main class="blank"><p>This account has no networks yet. Ask the administrator to add one.</p></main>
  {/if}
</div>

{#if app.showSettings}<SettingsDialog />{/if}
{/if}

<style>
  .app {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    /* One row exactly as tall as the app. With the default "auto" row, a long
       channel stretches the row to fit all its messages and pushes the input
       bar off the screen. */
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
  }
  main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
  .splash {
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--fg-dim);
  }
  .blank {
    display: grid;
    place-items: center;
    color: var(--fg-dim);
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .messages {
    flex: 1;
    min-width: 0;
  }
  .nav,
  .members {
    height: 100%;
  }

  @media (max-width: 720px) {
    .app {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .nav {
      display: none;
      position: fixed;
      inset: 0 0 0 52px;
      z-index: 10;
      box-shadow: 4px 0 16px rgb(0 0 0 / 0.3);
      width: min(260px, calc(100% - 52px));
    }
    .nav-open .nav {
      display: block;
    }
    .members {
      display: none;
    }
  }
</style>
