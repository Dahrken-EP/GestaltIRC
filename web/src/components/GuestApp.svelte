<script lang="ts">
  import { onMount } from 'svelte'
  import { GuestSession } from '../lib/guest/session.svelte'
  import { settings } from '../lib/settings.svelte'
  import DirectPanel from './DirectPanel.svelte'
  import InputBar from './InputBar.svelte'
  import MessagePane from './MessagePane.svelte'
  import VoiceAudio from './VoiceAudio.svelte'

  // What someone sees who opens a link from a Gestalt user: a name to give, then the same direct chat window a
  // Gestalt user has, with the person who sent the link.
  let { token }: { token: string } = $props()

  // The link does not change while the page is open.
  // svelte-ignore state_referenced_locally
  const session = new GuestSession(token)
  let name = $state('')
  let input: HTMLInputElement | undefined = $state()

  const net = $derived(session.net)
  const host = $derived(session.welcome?.host ?? '')
  const buf = $derived(net && host ? net.find('p2p:' + host.toLowerCase()) : undefined)

  onMount(() => input?.focus())

  $effect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.dataset.theme = settings.theme
    root.dataset.density = settings.density
  })

  $effect(() => {
    document.title = session.phase === 'joined' && host ? `Chat with ${host}` : 'Join a chat'
  })

  // Leaving by closing the page tells the host.
  function onpagehide() {
    if (session.phase === 'joined') session.leave()
  }
</script>

<svelte:window {onpagehide} />

{#if session.phase === 'name' || session.phase === 'joining'}
  <main class="join">
    <form
      class="card"
      onsubmit={(e) => {
        e.preventDefault()
        session.join(name)
      }}
    >
      <h1>Join a chat</h1>
      <p>Someone sent you a link to talk with them. Enter a name they will see, then connect.</p>
      <label>
        Your name
        <input bind:this={input} bind:value={name} maxlength="24" autocomplete="nickname" spellcheck="false" disabled={session.phase === 'joining'} />
      </label>
      {#if session.message}<p class="error" role="alert" data-testid="guest-error">{session.message}</p>{/if}
      <button class="btn primary" disabled={session.phase === 'joining' || !name.trim()}>
        {session.phase === 'joining' ? 'Connecting…' : 'Connect'}
      </button>
      <p class="dim">
        Your browser will connect straight to theirs, so they will be able to see your network address. This page does not
        need an account, and nothing you say is kept.
      </p>
    </form>
  </main>
{:else if session.phase === 'ended'}
  <main class="join">
    <div class="card" data-testid="guest-ended">
      <h1>This chat has ended</h1>
      <p>{session.message}</p>
      <p class="dim">The link may only work once, or only while the person who sent it is here. Ask them for a new one.</p>
    </div>
  </main>
{:else if net && buf}
  <div class="chat">
    <header>
      <h1>⚡ {host}</h1>
      <span class="dim">You are in as {session.welcome?.name}, a guest</span>
      <span class="grow"></span>
      <button class="btn" onclick={() => session.leave()}>Leave</button>
    </header>
    <DirectPanel {net} {buf} />
    <div class="messages">
      {#key buf.key}
        <MessagePane {net} {buf} filter="" onnick={() => {}} onchannel={() => {}} onreply={() => {}} />
      {/key}
    </div>
    <InputBar {net} {buf} reply={null} oncancelreply={() => {}} />
  </div>
  <VoiceAudio nets={[net]} />
{/if}

<style>
  .join {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 16px;
  }
  .card {
    width: min(380px, 100%);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 20px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  h1 {
    margin: 0;
    font-size: 1.2em;
  }
  p {
    margin: 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  input {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    padding: 6px 8px;
  }
  .dim {
    color: var(--fg-dim);
    font-size: 0.85em;
  }
  .error {
    color: var(--danger);
  }
  .chat {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  header h1 {
    font-size: 1em;
  }
  .grow {
    flex: 1;
  }
  .messages {
    flex: 1;
    min-height: 0;
  }
</style>
