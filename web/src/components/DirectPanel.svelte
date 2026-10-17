<script lang="ts">
  import { formatBytes } from '../lib/p2p/protocol'
  import type { Transfer } from '../lib/p2p/chat'
  import type { Buffer, NetworkState } from '../lib/network.svelte'

  let { net, buf }: { net: NetworkState; buf: Buffer } = $props()

  const chat = $derived(net.directChat(buf))
  const view = $derived(buf.p2p)
  const st = $derived(view?.state ?? 'idle')
  const connected = $derived(st === 'connected')
  let picker: HTMLInputElement
  let dragging = $state(false)
  let showDetails = $state(false)
  // The codes are for the moment someone wants to check them; each new connection starts with them out of sight.
  $effect(() => {
    if (!connected && cs !== 'connected') showDetails = false
  })
  const cv = $derived(buf.call)
  const cs = $derived(cv?.state ?? 'idle')
  const call = $derived(net.callFor(buf.name))
  const inCall = $derived(cs === 'calling' || cs === 'connecting' || cs === 'connected')

  function sendFiles(files: FileList | File[] | null) {
    if (!files || !connected) return
    for (const f of Array.from(files)) chat.offerFile(f)
  }

  function onpick() {
    sendFiles(picker.files)
    picker.value = ''
  }

  function ondrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    sendFiles(e.dataTransfer?.files ?? null)
  }

  /** Saves a received file. The link is made when it is clicked and dropped straight after. */
  function save(t: Transfer) {
    if (!t.blob) return
    const url = URL.createObjectURL(t.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = t.name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const percent = (t: Transfer) => (t.size === 0 ? 100 : Math.min(100, Math.floor((t.done / t.size) * 100)))
  const verb: Record<Transfer['state'], string> = {
    offered: 'Wants to send',
    waiting: 'Waiting for them to accept',
    active: 'Transferring',
    done: 'Done',
    failed: 'Failed',
    declined: 'Declined',
    cancelled: 'Cancelled',
  }
</script>

<section
  class="panel"
  class:dragging
  aria-label="Direct chat with {buf.title}"
  ondragover={(e) => {
    // Always claimed, or the browser would open a dropped file in this tab and leave the chat.
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      dragging = connected
    }
  }}
  ondragleave={() => (dragging = false)}
  {ondrop}
>
  <div class="status" data-state={st} role="status">
    {#if st === 'idle'}
      <span>Not connected.</span>
      <button class="btn primary" onclick={() => void chat.invite()}>Connect</button>
    {:else if st === 'calling'}
      <span>Waiting for {buf.title} to accept…</span>
      <button class="btn" onclick={() => chat.hangUp()}>Cancel</button>
    {:else if st === 'incoming'}
      <span>
        <strong>{buf.title}</strong> wants to chat directly. If you accept, your browsers connect to each other, and
        they will be able to see your network address.
      </span>
      <button class="btn primary" onclick={() => void chat.acceptIncoming()}>Accept</button>
      <button class="btn" onclick={() => chat.declineIncoming()}>Decline</button>
    {:else if st === 'connecting'}
      <span>Connecting…</span>
      <button class="btn" onclick={() => chat.hangUp()}>Cancel</button>
    {:else if st === 'connected'}
      <span>Connected directly to {buf.title}.</span>
      <button class="btn" onclick={() => picker.click()}>Send file…</button>
      <button class="btn" onclick={() => chat.hangUp()}>Hang up</button>
    {:else}
      <span>{view?.reason || 'The chat ended.'}</span>
      <button class="btn primary" onclick={() => void chat.invite()}>Connect again</button>
    {/if}
  </div>

  {#if (connected && view) || (cs === 'connected' && cv)}
    <div class="verify">
      <span>🔒 Encrypted, browser to browser</span>
      <button class="link" aria-expanded={showDetails} onclick={() => (showDetails = !showDetails)}>
        {showDetails ? 'Hide' : 'Verify…'}
      </button>
    </div>
    {#if showDetails}
      <div class="details" data-testid="verify-details">
        {#if connected && view}<p>Safety code <code data-testid="safety-code">{view.code}</code></p>{/if}
        {#if cs === 'connected' && cv}<p>Call safety code <code data-testid="call-code">{cv.code}</code></p>{/if}
        <p>
          Ask {buf.title} to read their safety code to you by a way other than this IRC network (a phone call, or in
          person). If it matches, nobody on the way, including the server and the bouncer, changed the connection.
          If it does not match, hang up.
        </p>
        {#if connected && view}
          <p class="fp">Your certificate: <code>{view.fingerprints.local}</code></p>
          <p class="fp">Theirs: <code>{view.fingerprints.remote}</code></p>
        {/if}
      </div>
    {/if}
  {/if}

  {#if net.canVoice}
    <div class="call" data-state={cs} role="status" aria-label="Voice call with {buf.title}">
      {#if cs === 'incoming'}
        <span>
          📞 <strong>{buf.title}</strong> is calling. Your microphone stays off until you answer. Answering shares your network
          address with them.
        </span>
        <button class="btn primary" onclick={() => void call.accept()}>Answer</button>
        <button class="btn" onclick={() => call.decline()}>Decline</button>
      {:else if cs === 'calling'}
        <span>📞 Calling {buf.title}…</span>
        <button class="btn" onclick={() => call.hangUp()}>Cancel</button>
      {:else if cs === 'connecting'}
        <span>📞 Connecting…</span>
        <button class="btn" onclick={() => call.hangUp()}>Cancel</button>
      {:else if cs === 'connected' && cv}
        <span class="who" class:speaking={cv.remoteSpeaking} data-testid="remote-speaking">
          <span class="dot" aria-hidden="true"></span>📞 In a call with {buf.title}
        </span>
        <span class="who me" class:speaking={cv.speaking} data-testid="call-me-speaking"><span class="dot" aria-hidden="true"></span>You{cv.muted ? ' (muted)' : ''}</span>
        <button class="btn" aria-pressed={cv.muted} onclick={() => call.setMuted(!cv.muted)}>{cv.muted ? 'Unmute' : 'Mute'}</button>
        <label class="vol"><span class="visually-hidden">Volume</span>
          <input type="range" min="0" max="1" step="0.05" value={cv.volume} oninput={(e) => call.setVolume(Number(e.currentTarget.value))} />
        </label>
        <button class="btn" onclick={() => call.hangUp()}>Hang up</button>
      {:else}
        <button class="btn" onclick={() => void call.invite()}>📞 {cs === 'ended' ? 'Call again' : 'Call'}</button>
        {#if cs === 'ended' && cv?.reason}<span class="dim">{cv.reason}</span>{/if}
        {#if cs === 'idle' && cv?.reason}<span class="dim">{cv.reason}</span>{/if}
      {/if}
    </div>
  {/if}

  <input bind:this={picker} type="file" multiple hidden onchange={onpick} data-testid="file-input" />

  {#if view && view.transfers.length}
    <ul class="transfers" aria-label="Files">
      {#each view.transfers as t (t.id)}
        <li data-state={t.state}>
          <span class="dir" aria-hidden="true">{t.dir === 'in' ? '↓' : '↑'}</span>
          <span class="name" title={t.name}>{t.name}</span>
          <span class="size">{formatBytes(t.size)}</span>
          <span class="what">{verb[t.state]}{t.error ? `: ${t.error}` : ''}</span>
          {#if t.state === 'active'}<progress max="100" value={percent(t)} aria-label="Progress"></progress>{/if}
          <span class="acts">
            {#if t.dir === 'in' && t.state === 'offered'}
              <button class="btn primary" onclick={() => chat.acceptFile(t.id)}>Accept</button>
              <button class="btn" onclick={() => chat.declineFile(t.id)}>Decline</button>
            {:else if t.state === 'active' || t.state === 'waiting'}
              <button class="btn" onclick={() => chat.cancelTransfer(t.id)}>Cancel</button>
            {:else if t.dir === 'in' && t.state === 'done'}
              <button class="btn primary" onclick={() => save(t)}>Save</button>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if view.transfers.some((t) => t.state === 'done' || t.state === 'failed' || t.state === 'declined' || t.state === 'cancelled')}
      <button class="link clear" onclick={() => chat.clearFinished()}>Clear finished</button>
    {/if}
  {/if}

  {#if dragging}<div class="drop">Drop files to send them to {buf.title}</div>{/if}
</section>

<style>
  .panel {
    position: relative;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
    padding: 6px 10px;
    max-height: 40%;
    overflow-y: auto;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .status span {
    flex: 1 1 14em;
    min-width: 0;
  }
  .status[data-state='connected'] span {
    color: var(--ok);
  }
  .status[data-state='ended'] span {
    color: var(--fg-dim);
  }
  .call {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }
  .call[data-state='connected'] {
    border-left: 3px solid var(--ok);
    padding-left: 8px;
  }
  .who {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--border);
  }
  .speaking .dot {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 35%, transparent);
  }
  .vol input {
    width: 6em;
  }
  .dim {
    color: var(--fg-dim);
  }
  .verify {
    display: flex;
    gap: 10px;
    align-items: baseline;
    margin-top: 4px;
    color: var(--fg-dim);
    font-size: 0.9em;
  }
  code {
    font-family: ui-monospace, monospace;
    color: var(--fg);
    overflow-wrap: anywhere;
  }
  .details {
    font-size: 0.85em;
    color: var(--fg-dim);
  }
  .details p {
    margin: 4px 0;
  }
  .link {
    color: var(--accent);
    text-decoration: underline;
    font-size: 0.85em;
  }
  .clear {
    margin-top: 4px;
  }
  .transfers {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .transfers li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: center;
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .name {
    font-weight: 600;
    max-width: 18em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size,
  .what {
    color: var(--fg-dim);
    font-size: 0.9em;
  }
  li[data-state='failed'] .what {
    color: var(--danger);
  }
  progress {
    flex: 1 1 8em;
    max-width: 16em;
  }
  .acts {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }
  .drop {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--accent) 22%, var(--bg-panel));
    border: 2px dashed var(--accent);
    font-weight: 600;
    pointer-events: none;
  }
</style>
