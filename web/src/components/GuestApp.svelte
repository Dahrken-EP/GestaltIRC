<script lang="ts">
  import { onMount } from 'svelte'
  import { GuestSession } from '../lib/guest/session.svelte'
  import { settings } from '../lib/settings.svelte'
  import { t } from '../lib/i18n.svelte'
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
    document.title = session.phase === 'joined' && host ? t('guest.title_chat', { name: host }) : t('guest.join')
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
      <h1>{t('guest.join')}</h1>
      <p>{t('guest.intro')}</p>
      <label>
        {t('guest.your_name')}
        <input bind:this={input} bind:value={name} maxlength="24" autocomplete="nickname" spellcheck="false" disabled={session.phase === 'joining'} />
      </label>
      {#if session.message}<p class="error" role="alert" data-testid="guest-error">{session.message}</p>{/if}
      <button class="btn primary" disabled={session.phase === 'joining' || !name.trim()}>
        {session.phase === 'joining' ? t('p2p.connecting') : t('button.connect')}
      </button>
      <p class="dim">
        {t('guest.privacy')}
      </p>
    </form>
  </main>
{:else if session.phase === 'ended'}
  <main class="join">
    <div class="card" data-testid="guest-ended">
      <h1>{t('guest.ended')}</h1>
      <p>{session.message}</p>
      <p class="dim">{t('guest.ended_hint')}</p>
    </div>
  </main>
{:else if net && buf && session.welcome?.kind === 'room'}
  {@const call = buf.call}
  {@const calling = !call || call.state === 'calling' || call.state === 'connecting' || call.state === 'incoming'}
  <div class="chat" data-testid="guest-room">
    <header>
      <h1>🎙 {session.welcome.target}</h1>
      <span class="dim">{t('guest.room_title', { host })} · {t('guest.you_are', { name: session.welcome.name })}</span>
      <span class="grow"></span>
      <button class="btn" onclick={() => session.leave()}>{t('guest.leave')}</button>
    </header>
    <section class="room">
      <div class="row">
        {#if calling}
          <span data-testid="guest-room-state" data-state="connecting">{t('guest.connecting_room')}</span>
        {:else if call?.state === 'connected'}
          <span data-testid="guest-room-state" data-state="connected" class:speaking={call.speaking}>{t('guest.in_room')}</span>
          <button class="btn" aria-pressed={call.muted} onclick={() => net.callFor(host).setMuted(!call.muted)}>{call.muted ? t('button.unmute') : t('button.mute')}</button>
        {:else}
          <span data-testid="guest-room-state" data-state="ended">{call?.reason || t('guest.room_ended')}</span>
          <button class="btn primary" onclick={() => net.callNick(host)}>{t('button.connect_again')}</button>
        {/if}
      </div>
      <ul class="people" data-testid="guest-roster">
        {#each session.roster as p (p.name + (p.guest ? '/g' : ''))}
          <li class:speaking={p.speaking}>
            <span class="dot" aria-hidden="true"></span>
            <span>{p.name}</span>
            {#if p.guest}<span class="tag">{t('voice.guest')}{p.name === session.welcome.name ? ', ' + t('guest.you') : ''}</span>{/if}
            {#if p.host}<span class="tag">{t('guest.tag_host')}</span>{/if}
          </li>
        {/each}
      </ul>
      <p class="dim">
        {t('guest.relays', { host })}
      </p>
    </section>
  </div>
  <VoiceAudio nets={[net]} />
{:else if net && buf}
  <div class="chat">
    <header>
      <h1>⚡ {host}</h1>
      <span class="dim">{t('guest.you_are', { name: session.welcome?.name ?? '' })}</span>
      <span class="grow"></span>
      <button class="btn" onclick={() => session.leave()}>{t('guest.leave')}</button>
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
  .room {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .people {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .people li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border);
  }
  .speaking .dot,
  .speaking {
    --speak: var(--ok);
  }
  li.speaking .dot {
    background: var(--ok);
  }
  .tag {
    font-size: 0.75em;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg-dim);
  }
  .messages {
    flex: 1;
    min-height: 0;
  }
</style>
