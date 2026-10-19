<script lang="ts">
  import { uniqueLinks } from '../lib/media'
  import { nickColor } from '../lib/nickcolor'
  import { tokenize } from '../lib/render'
  import { settings } from '../lib/settings.svelte'
  import { cannotHover, isInteractive, touchSelection } from '../lib/touch.svelte'
  import type { Buffer, ChatMessage, NetworkState } from '../lib/network.svelte'
  import MediaEmbeds from './MediaEmbeds.svelte'
  import ThreadIndicator from './ThreadIndicator.svelte'
  import TokenText from './TokenText.svelte'
  import { t } from '../lib/i18n.svelte'

  let {
    msg,
    prev,
    net,
    buf,
    onnick,
    onchannel,
    onreply,
  }: {
    msg: ChatMessage
    prev: ChatMessage | undefined
    net: NetworkState
    buf: Buffer
    onnick: (nick: string) => void
    onchannel: (name: string) => void
    onreply: (msg: ChatMessage) => void
  } = $props()

  const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢']

  const words = $derived([net.nick, ...settings.keywords])
  const tokens = $derived(tokenize(msg.text, words))
  const isChat = $derived(msg.kind === 'msg' || msg.kind === 'action' || msg.kind === 'notice')
  // Links in a message, for pictures, players and previews under it.
  const links = $derived(isChat ? uniqueLinks(tokens.flatMap((t) => (t.type === 'link' ? [t.href] : []))) : [])
  // Consecutive lines from one sender within five minutes drop the repeated nick.
  const merged = $derived(
    isChat && !!prev && prev.kind === msg.kind && prev.nick === msg.nick && msg.time - prev.time < 5 * 60_000,
  )
  const time = $derived(new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  const full = $derived(new Date(msg.time).toLocaleString())
  const color = (nick: string) => nickColor(nick, settings.nickColors)

  // Event lines ("joined", "left"…) keep the coloured nick from the translation,
  // by splitting the translated sentence around the placeholders' values.
  type Seg = { text: string; colored: string | null }
  const splitAround = (s: string, toks: string[]): Seg[] => {
    const segs: Seg[] = []
    let rest = s
    for (const tok of toks) {
      if (!tok) continue
      const i = rest.indexOf(tok)
      if (i < 0) continue
      if (i > 0) segs.push({ text: rest.slice(0, i), colored: null })
      segs.push({ text: tok, colored: tok })
      rest = rest.slice(i + tok.length)
    }
    if (rest) segs.push({ text: rest, colored: null })
    return segs.length ? segs : [{ text: s, colored: null }]
  }
  const ev = $derived.by(() => {
    const reason = msg.text ? ` (${msg.text})` : ''
    const key =
      msg.kind === 'join'
        ? 'msg.joined'
        : msg.kind === 'part'
          ? 'msg.left'
          : msg.kind === 'quit'
            ? 'msg.quit'
            : msg.kind === 'nick'
              ? 'msg.renamed'
              : msg.kind === 'kick'
                ? 'msg.kicked'
                : msg.kind === 'mode'
                  ? 'msg.set_mode'
                  : msg.kind === 'topic'
                    ? 'msg.set_topic'
                    : null
    if (!key) return null
    const vars: Record<string, string | number> =
      msg.kind === 'nick'
        ? { nick: msg.nick, target: msg.target ?? '' }
        : msg.kind === 'kick'
          ? { nick: msg.nick, target: msg.target ?? '', reason }
          : msg.kind === 'mode'
            ? { nick: msg.nick, mode: msg.text ?? '' }
            : { nick: msg.nick, reason }
    return splitAround(t(key, vars), [msg.nick, ...(msg.kind === 'nick' || msg.kind === 'kick' ? [msg.target ?? ''] : [])])
  })

  // Replies, reactions and deletion need the message to have an id and the network to support them.
  const canInteract = $derived(isChat && !!msg.msgid && buf.onNetwork)
  const canReact = $derived(canInteract && net.caps.has('message-tags'))
  const canReply = $derived(canInteract && net.caps.has('message-tags'))
  const canDelete = $derived(canInteract && msg.self && net.canRedact)
  const replied = $derived(msg.replyTo ? buf.byMsgId(msg.replyTo) : undefined)
  const reactions = $derived(msg.msgid ? [...(buf.reactions.get(msg.msgid) ?? [])] : [])
  let picking = $state(false)
  /** On a touch screen the buttons are shown for the message that was tapped. */
  const selected = $derived(touchSelection.key === msg.key)

  function tap(e: MouseEvent) {
    if (!(canReply || canReact || canDelete) || !cannotHover() || isInteractive(e.target)) return
    touchSelection.key = selected ? '' : msg.key
    picking = false
  }

  function done() {
    touchSelection.key = ''
    picking = false
  }

  function snippet(text: string): string {
    return text.length > 90 ? text.slice(0, 89) + '…' : text
  }

  function react(emoji: string) {
    net.react(buf, msg, emoji)
    done()
  }
</script>

<div class="line {msg.kind}" class:mention={msg.mention && isChat} class:self={msg.self} class:selected data-msgid={msg.msgid}>
  {#if msg.replyTo}
    <div class="reply">
      <span class="dim">↳</span>
      {#if replied}
        <button class="nick small" style:color={color(replied.nick)} onclick={() => onnick(replied.nick)}>{replied.nick}</button>
        <span class="quote">{snippet(replied.text)}</span>
      {:else}
        <span class="quote">{t('msg.not_loaded')}</span>
      {/if}
    </div>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="main" onclick={tap}>
    {#if settings.timestamps}
      <time class="time" datetime={new Date(msg.time).toISOString()} title={full}>{time}</time>
    {/if}

    {#if msg.kind === 'msg' || msg.kind === 'notice'}
      <span class="who">
        {#if !merged}
          {#if msg.kind === 'notice'}<span class="dim">-</span>{:else}<span class="dim">&lt;</span>{/if}<button class="nick" style:color={color(msg.nick)} onclick={() => onnick(msg.nick)}>{msg.nick}</button>{#if msg.kind === 'notice'}<span class="dim">-</span>{:else}<span class="dim">&gt;</span>{/if}
        {/if}
      </span>
      <span class="text"><TokenText {tokens} {onchannel} /></span>
    {:else if msg.kind === 'action'}
      <span class="who"><span class="dim">*</span></span>
      <span class="text">
        <button class="nick" style:color={color(msg.nick)} onclick={() => onnick(msg.nick)}>{msg.nick}</button>
        <TokenText {tokens} {onchannel} />
      </span>
    {:else}
      <span class="who"><span class="dim">{msg.kind === 'error' ? '!' : '–'}</span></span>
      <span class="text event">
        {#if ev === null}
          <TokenText {tokens} {onchannel} />
        {:else}
          {#each ev as seg, i (i)}
            {#if seg.colored !== null}<span style:color={color(seg.colored)}>{seg.colored}</span>{:else}{seg.text}{/if}
          {/each}
          {#if msg.kind === 'topic'} <TokenText {tokens} {onchannel} />{/if}
        {/if}
      </span>
    {/if}

    {#if canReply || canReact || canDelete}
      <span class="tools" class:open={picking || selected}>
        {#if canReply}
          <button title={t('msg.reply')} aria-label={t('msg.reply_to', { nick: msg.nick })} onclick={() => (onreply(msg), done())}>↩</button>
        {/if}
        {#if canReact}
          <button title={t('msg.react')} aria-label={t('msg.react')} aria-expanded={picking} onclick={() => (picking = !picking)}>☺</button>
        {/if}
        {#if canDelete}
          <button class="del" title={t('msg.delete')} aria-label={t('msg.delete')} onclick={() => (net.redact(buf, msg), done())}>🗑</button>
        {/if}
        {#if picking}
          <span class="palette" role="group" aria-label={t('msg.palette')}>
            {#each QUICK_REACTIONS as emoji (emoji)}
              <button aria-label={t('msg.react_with', { emoji })} onclick={() => react(emoji)}>{emoji}</button>
            {/each}
          </span>
        {/if}
      </span>
    {/if}
    {#if msg.msgid && buf.replyCount(msg.msgid) > 0}
      <ThreadIndicator {msg} {buf} />
    {/if}
  </div>

  {#if links.length}
    <div class="embeds"><MediaEmbeds {links} /></div>
  {/if}

  {#if reactions.length}
    <div class="reactions">
      {#each reactions as [emoji, nicks] (emoji)}
        <button
          class="chip"
          class:mine={nicks.some((n) => n.toLowerCase() === net.nick.toLowerCase())}
          disabled={!canReact}
          title={nicks.join(', ')}
          aria-pressed={nicks.some((n) => n.toLowerCase() === net.nick.toLowerCase())}
          aria-label={t('msg.from', { emoji, nicks: nicks.join(', ') })}
          onclick={() => react(emoji)}>{emoji} {nicks.length}</button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .line {
    padding: var(--row-pad) 10px var(--row-pad) 8px;
    border-left: 3px solid transparent;
    position: relative;
  }
  .main {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .line:hover,
  .line:focus-within {
    background: var(--bg-hover);
  }
  .line.mention {
    background: var(--mention-bg);
    border-left-color: var(--mention-bar);
  }
  .time {
    flex: none;
    color: var(--fg-dim);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    min-width: 3.2em;
  }
  .who {
    /* One fixed column for the sender, so every message's text starts at the
       same point no matter how long the nick is. Nicks longer than the column
       are cut off with an ellipsis instead of pushing the text sideways, and a
       message that follows the same sender (which leaves the nick out) keeps
       the same start instead of sliding back to a narrower column. */
    flex: none;
    /* Room for a 15-character nick (the width of "0" is wider than an average letter) beside its < > markers. */
    width: calc(15ch + 2em);
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
  }
  .text {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .nick {
    font-weight: 600;
  }
  /* A nick too long for its column keeps its head and an ellipsis, leaving the
     < > markers beside it visible. */
  .who .nick {
    display: inline-block;
    vertical-align: baseline;
    max-width: calc(100% - 1.5em);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nick:hover {
    text-decoration: underline;
  }
  .nick.small {
    font-size: 0.9em;
  }
  .dim,
  .event {
    color: var(--fg-dim);
  }
  .error .text {
    color: var(--danger);
  }
  .action .text {
    font-style: italic;
  }
  .notice .text {
    color: var(--fg-dim);
  }
  .self .text {
    color: var(--fg);
  }

  .reply {
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding-left: calc(3.2em + 16px);
    font-size: 0.85em;
    color: var(--fg-dim);
    overflow: hidden;
    white-space: nowrap;
  }
  .quote {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tools {
    position: absolute;
    right: 8px;
    top: -2px;
    display: none;
    gap: 2px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0 2px;
    z-index: 2;
  }
  .line:hover .tools,
  .line:focus-within .tools,
  .tools.open {
    display: flex;
  }
  .tools button {
    padding: 0 6px;
    line-height: 1.6;
  }
  .tools button:hover {
    background: var(--bg-hover);
    border-radius: 4px;
  }
  .del:hover {
    color: var(--danger);
  }
  .palette {
    display: flex;
    gap: 0;
    border-left: 1px solid var(--border);
    margin-left: 2px;
  }

  /* A finger needs bigger targets than a mouse, and the bar must not hide the line being tapped. */
  @media (hover: none) {
    /* A browser leaves :hover on the last thing tapped; only a tap on the message itself shows its buttons. */
    .line:hover .tools:not(.open),
    .line:focus-within .tools:not(.open) {
      display: none;
    }
    .line.selected {
      background: var(--bg-hover);
    }
    .tools {
      top: -22px;
      flex-wrap: wrap;
      max-width: calc(100vw - 16px);
    }
    .tools button {
      min-width: 40px;
      min-height: 36px;
      font-size: 1.15em;
    }
  }

  .embeds {
    padding: 0 0 2px calc(3.2em + 16px);
  }

  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 2px 0 0 calc(3.2em + 16px);
  }
  .chip {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0 8px;
    font-size: 0.85em;
    background: var(--bg-panel);
  }
  .chip.mine {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 18%, var(--bg-panel));
  }
  .chip:disabled {
    cursor: default;
  }
</style>
