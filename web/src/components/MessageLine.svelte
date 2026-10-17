<script lang="ts">
  import { nickColor } from '../lib/nickcolor'
  import { tokenize } from '../lib/render'
  import { settings } from '../lib/settings.svelte'
  import type { ChatMessage, NetworkState } from '../lib/network.svelte'
  import TokenText from './TokenText.svelte'

  let {
    msg,
    prev,
    net,
    onnick,
    onchannel,
  }: {
    msg: ChatMessage
    prev: ChatMessage | undefined
    net: NetworkState
    onnick: (nick: string) => void
    onchannel: (name: string) => void
  } = $props()

  const words = $derived([net.nick, ...settings.keywords])
  const tokens = $derived(tokenize(msg.text, words))
  const isChat = $derived(msg.kind === 'msg' || msg.kind === 'action' || msg.kind === 'notice')
  // Consecutive lines from one sender within five minutes drop the repeated nick.
  const merged = $derived(
    isChat && !!prev && prev.kind === msg.kind && prev.nick === msg.nick && msg.time - prev.time < 5 * 60_000,
  )
  const time = $derived(new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  const full = $derived(new Date(msg.time).toLocaleString())
  const color = (nick: string) => nickColor(nick, settings.nickColors)
</script>

<div class="line {msg.kind}" class:mention={msg.mention && isChat} class:self={msg.self}>
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
</div>

<style>
  .line {
    display: flex;
    gap: 8px;
    padding: var(--row-pad) 10px var(--row-pad) 8px;
    border-left: 3px solid transparent;
    align-items: baseline;
  }
  .line:hover {
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
</style>
