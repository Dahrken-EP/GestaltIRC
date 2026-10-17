<script lang="ts">
  import type { Buffer, NetworkState } from '../lib/network.svelte'
  import { MAX_VOICE } from '../lib/voice/presence'
  import { nickColor } from '../lib/nickcolor'
  import { settings } from '../lib/settings.svelte'

  let { net, buf }: { net: NetworkState; buf: Buffer } = $props()

  const v = $derived(buf.voice)
  // Made when first used: most channels never have voice, and a room holds timers and streams.
  const room = () => net.voiceRoom(buf)
  const active = $derived(v?.state === 'active')
  const joining = $derived(v?.state === 'joining')
  const hint = $derived(buf.voiceMembers.filter((n) => !v?.participants.some((p) => p.nick.toLowerCase() === n.toLowerCase())))
  const canJoin = $derived(net.canVoice && buf.joined)
  let showCodes = $state(false)

  const ptt = $derived(active && !!v?.pushToTalk)

  function setPushToTalk(on: boolean) {
    settings.pushToTalk = on
    settings.save()
    room().setPushToTalk(on)
  }

  /** The talk key is Ctrl+Space, held. It works while the message box has focus, which a plain key could not. */
  function keydown(e: KeyboardEvent) {
    if (!ptt || !e.ctrlKey || e.code !== 'Space') return
    e.preventDefault()
    if (!e.repeat) room().setTalking(true)
  }

  function keyup(e: KeyboardEvent) {
    if (ptt && (e.code === 'Space' || e.key === 'Control')) room().setTalking(false)
  }

  const stopTalking = () => ptt && room().setTalking(false)
</script>

<svelte:window onkeydown={keydown} onkeyup={keyup} onblur={stopTalking} />

{#if canJoin || active || joining}
  <section class="voice" class:on={active} aria-label="Voice chat in {buf.name}">
    <div class="row">
      {#if active}
        <span class="me" class:speaking={v?.speaking} data-testid="me-speaking" title="You">
          <span class="dot" aria-hidden="true"></span>You{v?.listenOnly ? ' (listening only)' : v?.pushToTalk ? '' : v?.muted ? ' (muted)' : ''}
        </span>
        {#if v?.listenOnly}
          <span class="dim">🎧 You hear the room but cannot be heard. Leave and join again to talk.</span>
        {:else if v?.pushToTalk}
          <button
            class="btn talk"
            class:held={v.talking}
            data-testid="talk"
            aria-pressed={v.talking}
            title="Hold to talk, or hold Ctrl+Space"
            onpointerdown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), room().setTalking(true))}
            onpointerup={() => room().setTalking(false)}
            onpointercancel={() => room().setTalking(false)}
            onkeydown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && (e.preventDefault(), room().setTalking(true))}
            onkeyup={(e) => (e.key === ' ' || e.key === 'Enter') && room().setTalking(false)}>🎙 Hold to talk</button
          >
        {:else}
          <button class="btn" aria-pressed={v?.muted} onclick={() => room().setMuted(!v?.muted)}>{v?.muted ? 'Unmute' : 'Mute'}</button>
        {/if}
        {#if !v?.listenOnly}
          <label class="check small">
            <input type="checkbox" checked={v?.pushToTalk} onchange={(e) => setPushToTalk(e.currentTarget.checked)} /> Push to talk
          </label>
        {/if}
        <button class="btn" onclick={() => net.leaveVoice(buf)}>Leave voice</button>
        <button class="link" aria-expanded={showCodes} onclick={() => (showCodes = !showCodes)}>{showCodes ? 'Hide codes' : 'Safety codes'}</button>
      {:else if joining}
        <span>Waiting for your microphone…</span>
        <button class="btn" onclick={() => net.leaveVoice(buf)}>Cancel</button>
      {:else}
        <button class="btn" onclick={() => net.joinVoice(buf)}>🎙 Join voice</button>
        <button class="btn" title="Hear the room without a microphone" onclick={() => net.joinVoice(buf, true)}>🎧 Listen only</button>
        {#if hint.length}
          <span class="dim">In voice: {hint.join(', ')}</span>
        {:else}
          <span class="dim">Talk with whoever else joins (up to {MAX_VOICE}). Audio goes straight between browsers.</span>
        {/if}
      {/if}
      {#if v?.error}<span class="error" role="alert">{v.error}</span>{/if}
    </div>

    {#if active && buf.guestLink}
      <div class="guestlink" data-testid="guest-link">
        <span class="dim">Guests can join from any browser:</span>
        <input readonly value={buf.guestLink} aria-label="Guest link" onfocus={(e) => e.currentTarget.select()} />
        <button class="btn" onclick={() => void navigator.clipboard?.writeText(buf.guestLink).catch(() => {})}>Copy</button>
      </div>
    {/if}

    {#if active}
      {#if v!.participants.length === 0}
        <p class="dim alone">Nobody else is in the voice room yet.{hint.length ? '' : ' Others can join with the button in this channel.'}</p>
      {/if}
      <ul class="people">
        {#each v!.participants as p (p.nick)}
          <li class:speaking={p.speaking} data-state={p.state} data-testid="voice-person">
            <span class="dot" aria-hidden="true"></span>
            <span class="nick" style:color={nickColor(p.label, settings.nickColors)}>{p.label}</span>
            {#if p.guest}<span class="guest" data-testid="guest-badge">guest{p.via ? `, with ${p.via}` : ''}</span>{/if}
            <span class="dim state">{p.state === 'connected' ? (p.speaking ? 'speaking' : '') : p.state === 'failed' ? 'could not connect' : 'connecting…'}</span>
            {#if p.state === 'connected' && p.stream}
              <label class="vol">
                <span class="visually-hidden">Volume for {p.nick}</span>
                <input type="range" min="0" max="1" step="0.05" value={p.volume} oninput={(e) => room().setVolume(p.nick, Number(e.currentTarget.value))} />
              </label>
              {#if showCodes && p.code}<code title="Compare with {p.label} out loud">{p.code}</code>{/if}
            {/if}
          </li>
        {/each}
      </ul>
      {#if showCodes}
        <p class="dim note">Each code is shared by you and that person only. Read it to each other another way; if it matches, nobody altered the connection.</p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .guestlink {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0 4px;
  }
  .guestlink input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    padding: 3px 6px;
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .guest {
    font-size: 0.75em;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg-dim);
  }
  .voice {
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .voice.on {
    border-left: 3px solid var(--ok);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .dim {
    color: var(--fg-dim);
    font-size: 0.9em;
  }
  .error {
    color: var(--danger);
  }
  .check {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--fg-dim);
  }
  .small {
    font-size: 0.85em;
  }
  .talk {
    min-width: 9em;
    touch-action: none;
    user-select: none;
  }
  .talk.held {
    background: var(--ok);
    border-color: var(--ok);
    color: #fff;
  }
  .link {
    color: var(--accent);
    text-decoration: underline;
    font-size: 0.85em;
  }
  .people {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  .people li,
  .me {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--border);
    flex: none;
  }
  .speaking .dot {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 35%, transparent);
  }
  li[data-state='failed'] .dot {
    background: var(--danger);
  }
  li[data-state='connecting'] .dot {
    background: var(--warn);
  }
  .nick {
    font-weight: 600;
  }
  .vol input {
    width: 6em;
  }
  code {
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
  }
  .alone,
  .note {
    margin: 4px 0 0;
  }
</style>
