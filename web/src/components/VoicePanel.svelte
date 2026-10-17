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
</script>

{#if canJoin || active || joining}
  <section class="voice" class:on={active} aria-label="Voice chat in {buf.name}">
    <div class="row">
      {#if active}
        <span class="me" class:speaking={v?.speaking} data-testid="me-speaking" title="You">
          <span class="dot" aria-hidden="true"></span>You{v?.muted ? ' (muted)' : ''}
        </span>
        <button class="btn" aria-pressed={v?.muted} onclick={() => room().setMuted(!v?.muted)}>{v?.muted ? 'Unmute' : 'Mute'}</button>
        <button class="btn" onclick={() => net.leaveVoice(buf)}>Leave voice</button>
        <button class="link" aria-expanded={showCodes} onclick={() => (showCodes = !showCodes)}>{showCodes ? 'Hide codes' : 'Safety codes'}</button>
      {:else if joining}
        <span>Waiting for your microphone…</span>
        <button class="btn" onclick={() => net.leaveVoice(buf)}>Cancel</button>
      {:else}
        <button class="btn" onclick={() => net.joinVoice(buf)}>🎙 Join voice</button>
        {#if hint.length}
          <span class="dim">In voice: {hint.join(', ')}</span>
        {:else}
          <span class="dim">Talk with whoever else joins (up to {MAX_VOICE}). Audio goes straight between browsers.</span>
        {/if}
      {/if}
      {#if v?.error}<span class="error" role="alert">{v.error}</span>{/if}
    </div>

    {#if active}
      {#if v!.participants.length === 0}
        <p class="dim alone">Nobody else is in the voice room yet.{hint.length ? '' : ' Others can join with the button in this channel.'}</p>
      {/if}
      <ul class="people">
        {#each v!.participants as p (p.nick)}
          <li class:speaking={p.speaking} data-state={p.state} data-testid="voice-person">
            <span class="dot" aria-hidden="true"></span>
            <span class="nick" style:color={nickColor(p.nick, settings.nickColors)}>{p.nick}</span>
            <span class="dim state">{p.state === 'connected' ? (p.speaking ? 'speaking' : '') : p.state === 'failed' ? 'could not connect' : 'connecting…'}</span>
            {#if p.state === 'connected'}
              <label class="vol">
                <span class="visually-hidden">Volume for {p.nick}</span>
                <input type="range" min="0" max="1" step="0.05" value={p.volume} oninput={(e) => room().setVolume(p.nick, Number(e.currentTarget.value))} />
              </label>
              {#if showCodes}<code title="Compare with {p.nick} out loud">{p.code}</code>{/if}
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
