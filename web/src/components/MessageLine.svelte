<script lang="ts">
  import { uniqueLinks } from '../lib/media'
  import { nickColor } from '../lib/nickcolor'
  import { tokenize } from '../lib/render'
  import { settings } from '../lib/settings.svelte'
  import type { Buffer, ChatMessage, NetworkState } from '../lib/network.svelte'
  import MediaEmbeds from './MediaEmbeds.svelte'
  import TokenText from './TokenText.svelte'

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

  // Replies, reactions and deletion need the message to have an id and the network to support them.
  const canInteract = $derived(isChat && !!msg.msgid && buf.onNetwork)
  const canReact = $derived(canInteract && net.caps.has('message-tags'))
  const canReply = $derived(canInteract && net.caps.has('message-tags'))
  const canDelete = $derived(canInteract && msg.self && net.canRedact)
  const replied = $derived(msg.replyTo ? buf.byMsgId(msg.replyTo) : undefined)
  const reactions = $derived(msg.msgid ? [...(buf.reactions.get(msg.msgid) ?? [])] : [])
  let picking = $state(false)

  function snippet(text: string): string {
    return text.length > 90 ? text.slice(0, 89) + '…' : text
  }

  function react(emoji: string) {
    net.react(buf, msg, emoji)
    picking = false
  }
</script>

<div class="line {msg.kind}" class:mention={msg.mention && isChat} class:self={msg.self} data-msgid={msg.msgid}>
  {#if msg.replyTo}
    <div class="reply">
      <span class="dim">↳</span>
      {#if replied}
        <button class="nick small" style:color={color(replied.nick)} onclick={() => onnick(replied.nick)}>{replied.nick}</button>
        <span class="quote">{snippet(replied.text)}</span>
      {:else}
        <span class="quote">a message that is not loaded</span>
      {/if}
    </div>
  {/if}

  <div class="main">
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
        {#if msg.kind === 'join'}
          <span style:color={color(msg.nick)}>{msg.nick}</span> joined
        {:else if msg.kind === 'part'}
          <span style:color={color(msg.nick)}>{msg.nick}</span> left{msg.text ? ` (${msg.text})` : ''}
        {:else if msg.kind === 'quit'}
          <span style:color={color(msg.nick)}>{msg.nick}</span> quit{msg.text ? ` (${msg.text})` : ''}
        {:else if msg.kind === 'nick'}
          <span style:color={color(msg.nick)}>{msg.nick}</span> is now known as <span style:color={color(msg.target ?? '')}>{msg.target}</span>
        {:else if msg.kind === 'kick'}
          <span style:color={color(msg.nick)}>{msg.nick}</span> kicked <span style:color={color(msg.target ?? '')}>{msg.target}</span>{msg.text ? ` (${msg.text})` : ''}
        {:else if msg.kind === 'mode'}
          <span style:color={color(msg.nick)}>{msg.nick}</span> set mode {msg.text}
        {:else if msg.kind === 'topic'}
          <span style:color={color(msg.nick)}>{msg.nick}</span> set the topic: <TokenText {tokens} {onchannel} />
        {:else}
          <TokenText {tokens} {onchannel} />
        {/if}
      </span>
    {/if}

    {#if canReply || canReact || canDelete}
      <span class="tools" class:open={picking}>
        {#if canReply}
          <button title="Reply" aria-label="Reply to {msg.nick}" onclick={() => onreply(msg)}>↩</button>
        {/if}
        {#if canReact}
          <button title="Add reaction" aria-label="Add reaction" aria-expanded={picking} onclick={() => (picking = !picking)}>☺</button>
        {/if}
        {#if canDelete}
          <button class="del" title="Delete message" aria-label="Delete message" onclick={() => net.redact(buf, msg)}>🗑</button>
        {/if}
        {#if picking}
          <span class="palette" role="group" aria-label="Choose a reaction">
            {#each QUICK_REACTIONS as emoji (emoji)}
              <button aria-label="React with {emoji}" onclick={() => react(emoji)}>{emoji}</button>
            {/each}
          </span>
        {/if}
      </span>
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
          aria-label="{emoji} from {nicks.join(', ')}"
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
    flex: none;
    min-width: 5.5em;
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 14em;
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
