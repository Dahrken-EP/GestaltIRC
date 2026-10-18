<script lang="ts">
  import { formatBytes } from '../lib/p2p/protocol'
  import type { Transfer } from '../lib/p2p/chat'
  import type { Buffer, NetworkState } from '../lib/network.svelte'
  import { t as t2 } from '../lib/i18n.svelte'

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

  /** Splits a translated sentence around the nickname so it can be bolded in any language. */
  const boldAround = (s: string, name: string): { text: string; bold: boolean }[] => {
    const i = name ? s.indexOf(name) : -1
    if (i < 0) return [{ text: s, bold: false }]
    const out: { text: string; bold: boolean }[] = []
    if (i > 0) out.push({ text: s.slice(0, i), bold: false })
    out.push({ text: name, bold: true })
    if (i + name.length < s.length) out.push({ text: s.slice(i + name.length), bold: false })
    return out
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
  const verb = $derived<Record<Transfer['state'], string>>({
    offered: t2('transfer.offered'),
    waiting: t2('transfer.waiting'),
    active: t2('transfer.active'),
    done: t2('transfer.done'),
    failed: t2('transfer.failed'),
    declined: t2('transfer.declined'),
    cancelled: t2('transfer.cancelled'),
  })
</script>

<section
  class="panel"
  class:dragging
  aria-label={t2('p2p.aria', { name: buf.title })}
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
      <span>{t2('p2p.not_connected')}</span>
      <button class="btn primary" onclick={() => void chat.invite()}>{t2('button.connect')}</button>
    {:else if st === 'calling'}
      <span>{t2('p2p.waiting', { name: buf.title })}</span>
      <button class="btn" onclick={() => chat.hangUp()}>{t2('button.cancel')}</button>
    {:else if st === 'incoming'}
      <span>
        {#each boldAround(t2('p2p.incoming', { name: buf.title }), buf.title) as seg}
          {#if seg.bold}<strong>{seg.text}</strong>{:else}{seg.text}{/if}
        {/each}
      </span>
      <button class="btn primary" onclick={() => void chat.acceptIncoming()}>{t2('button.accept')}</button>
      <button class="btn" onclick={() => chat.declineIncoming()}>{t2('button.decline')}</button>
    {:else if st === 'connecting'}
      <span>{t2('p2p.connecting')}</span>
      <button class="btn" onclick={() => chat.hangUp()}>{t2('button.cancel')}</button>
    {:else if st === 'connected'}
      <span>{t2('p2p.connected_to', { name: buf.title })}</span>
      <button class="btn" onclick={() => picker.click()}>{t2('button.send_file')}</button>
      <button class="btn" onclick={() => chat.hangUp()}>{t2('button.hang_up')}</button>
    {:else}
      <span>{view?.reason || t2('p2p.ended')}</span>
      <button class="btn primary" onclick={() => void chat.invite()}>{t2('button.connect_again')}</button>
    {/if}
  </div>

  {#if (connected && view) || (cs === 'connected' && cv)}
    <div class="verify">
      <span>{t2('p2p.encrypted')}</span>
      <button class="link" aria-expanded={showDetails} onclick={() => (showDetails = !showDetails)}>
        {showDetails ? t2('p2p.hide') : t2('p2p.verify')}
      </button>
    </div>
    {#if showDetails}
      <div class="details" data-testid="verify-details">
        {#if connected && view}<p>{t2('p2p.safety_code')} <code data-testid="safety-code">{view.code}</code></p>{/if}
        {#if cs === 'connected' && cv}<p>{t2('p2p.call_code')} <code data-testid="call-code">{cv.code}</code></p>{/if}
        <p>{t2('p2p.verify_note', { name: buf.title })}</p>
        {#if connected && view}
          <p class="fp">{t2('p2p.your_cert')} <code>{view.fingerprints.local}</code></p>
          <p class="fp">{t2('p2p.their_cert')} <code>{view.fingerprints.remote}</code></p>
        {/if}
      </div>
    {/if}
  {/if}

  {#if net.canVoice}
    <div class="call" data-state={cs} role="status" aria-label={t2('p2p.call_aria', { name: buf.title })}>
      {#if cs === 'incoming'}
        <span>
          📞 {#each boldAround(t2('p2p.call_incoming', { name: buf.title }), buf.title) as seg}
            {#if seg.bold}<strong>{seg.text}</strong>{:else}{seg.text}{/if}
          {/each}
        </span>
        <button class="btn primary" onclick={() => void call.accept()}>{t2('button.accept')}</button>
        <button class="btn" onclick={() => call.decline()}>{t2('button.decline')}</button>
      {:else if cs === 'calling'}
        <span>📞 {t2('p2p.calling', { name: buf.title })}</span>
        <button class="btn" onclick={() => call.hangUp()}>{t2('button.cancel')}</button>
      {:else if cs === 'connecting'}
        <span>📞 {t2('p2p.connecting')}</span>
        <button class="btn" onclick={() => call.hangUp()}>{t2('button.cancel')}</button>
      {:else if cs === 'connected' && cv}
        <span class="who" class:speaking={cv.remoteSpeaking} data-testid="remote-speaking">
          <span class="dot" aria-hidden="true"></span>📞 {t2('p2p.in_call', { name: buf.title })}
        </span>
        <span class="who me" class:speaking={cv.speaking} data-testid="call-me-speaking"><span class="dot" aria-hidden="true"></span>{t2('p2p.you')}{cv.muted ? ' ' + t2('p2p.muted') : ''}</span>
        <button class="btn" aria-pressed={cv.muted} onclick={() => call.setMuted(!cv.muted)}>{cv.muted ? t2('button.unmute') : t2('button.mute')}</button>
        <label class="vol"><span class="visually-hidden">{t2('button.volume')}</span>
          <input type="range" min="0" max="1" step="0.05" value={cv.volume} oninput={(e) => call.setVolume(Number(e.currentTarget.value))} />
        </label>
        <button class="btn" onclick={() => call.hangUp()}>{t2('button.hang_up')}</button>
      {:else}
        <button class="btn" onclick={() => void call.invite()}>📞 {cs === 'ended' ? t2('p2p.call_again') : t2('p2p.call')}</button>
        {#if cs === 'ended' && cv?.reason}<span class="dim">{cv.reason}</span>{/if}
        {#if cs === 'idle' && cv?.reason}<span class="dim">{cv.reason}</span>{/if}
      {/if}
    </div>
  {/if}

  <input bind:this={picker} type="file" multiple hidden onchange={onpick} data-testid="file-input" />

  {#if view && view.transfers.length}
    <ul class="transfers" aria-label={t2('p2p.files')}>
      {#each view.transfers as t (t.id)}
        <li data-state={t.state}>
          <span class="dir" aria-hidden="true">{t.dir === 'in' ? '↓' : '↑'}</span>
          <span class="name" title={t.name}>{t.name}</span>
          <span class="size">{formatBytes(t.size)}</span>
          <span class="what">{verb[t.state]}{t.error ? `: ${t.error}` : ''}</span>
          {#if t.state === 'active'}<progress max="100" value={percent(t)} aria-label={t2('p2p.progress')}></progress>{/if}
          <span class="acts">
            {#if t.dir === 'in' && t.state === 'offered'}
              <button class="btn primary" onclick={() => chat.acceptFile(t.id)}>{t2('button.accept')}</button>
              <button class="btn" onclick={() => chat.declineFile(t.id)}>{t2('button.decline')}</button>
            {:else if t.state === 'active' || t.state === 'waiting'}
              <button class="btn" onclick={() => chat.cancelTransfer(t.id)}>{t2('button.cancel')}</button>
            {:else if t.dir === 'in' && t.state === 'done'}
              <button class="btn primary" onclick={() => save(t)}>{t2('button.save')}</button>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if view.transfers.some((t) => t.state === 'done' || t.state === 'failed' || t.state === 'declined' || t.state === 'cancelled')}
      <button class="link clear" onclick={() => chat.clearFinished()}>{t2('button.clear_finished')}</button>
    {/if}
  {/if}

  {#if dragging}<div class="drop">{t2('p2p.drop', { name: buf.title })}</div>{/if}
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
