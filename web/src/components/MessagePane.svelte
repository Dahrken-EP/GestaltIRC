<script lang="ts">
  import type { Buffer, ChatMessage, NetworkState } from '../lib/network.svelte'
  import MessageLine from './MessageLine.svelte'
  import { filterMessages } from '../lib/search'
  import VirtualList from './VirtualList.svelte'

  interface SearchResult {
    id: number
    target: string
    time: number
    nick: string
    text: string
    msgid: string
  }

  let { net, buf, filter = '', searchResults = [], onnick, onchannel, onreply }: {
    net: NetworkState
    buf: Buffer
    /** Show only the messages that match this search. */
    filter?: string
    /** Server-side search results, newest first. */
    searchResults?: SearchResult[]
    onnick: (nick: string) => void
    onchannel: (name: string) => void
    onreply: (msg: ChatMessage) => void
  } = $props()

  type Row =
    | { key: string; kind: 'older' }
    | { key: string; kind: 'empty' }
    | { key: string; kind: 'nomatch' }
    | { key: string; kind: 'day'; time: number }
    | { key: string; kind: 'msg'; msg: ChatMessage; prev: ChatMessage | undefined }

  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

  const rows = $derived.by(() => {
    const out: Row[] = []
    if (buf.onNetwork) out.push({ key: 'older', kind: 'older' })
    // When we have server-side search results, use those instead of client-side filtering.
    if (searchResults && searchResults.length > 0) {
      for (const r of searchResults) {
        const msg: ChatMessage = {
          id: r.id,
          key: `search-${r.id}`,
          time: r.time,
          kind: 'msg',
          nick: r.nick,
          text: r.text,
          self: false,
          mention: false,
          msgid: r.msgid,
        }
        out.push({ key: `m${r.id}`, kind: 'msg', msg, prev: undefined })
      }
      return out
    }
    const list = filterMessages(buf.messages, filter)
    if (list.length === 0 && filter.trim()) out.push({ key: 'nomatch', kind: 'nomatch' })
    else if (list.length === 0 && buf.kind === 'status') out.push({ key: 'empty', kind: 'empty' })
    for (let i = 0; i < list.length; i++) {
      const msg = list[i]!
      const prev = list[i - 1]
      if (!prev || !sameDay(prev.time, msg.time)) out.push({ key: `d${msg.id}`, kind: 'day', time: msg.time })
      out.push({ key: `m${msg.id}`, kind: 'msg', msg, prev })
    }
    return out
  })

  function dayLabel(t: number): string {
    return new Date(t).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }

  let list: VirtualList<Row>
  let atBottom = $state(true)
</script>

<div class="wrap">
<VirtualList bind:this={list} bind:atBottom items={rows} estimate={22} label="Messages in {buf.name || net.label}" onreachtop={() => buf.messages.length && net.loadOlder(buf)}>
  {#snippet children(row)}
    {#if row.kind === 'older'}
      <div class="older">
        {#if buf.historyLoading}
          <span>Loading…</span>
        {:else if buf.historyExhausted}
          <span>Start of history</span>
        {:else}
          <button class="btn" onclick={() => net.loadOlder(buf)}>Load older messages</button>
        {/if}
      </div>
    {:else if row.kind === 'empty'}
      <p class="empty">Type /help for commands. Channels you have joined appear on the left.</p>
    {:else if row.kind === 'nomatch'}
      <p class="empty">Nothing here matches “{filter.trim()}”. Older messages may: use “Load older messages” above.</p>
    {:else if row.kind === 'day'}
      <div class="day"><span>{dayLabel(row.time)}</span></div>
    {:else}
      <MessageLine msg={row.msg} prev={row.prev} {net} {buf} {onnick} {onchannel} {onreply} />
    {/if}
  {/snippet}
</VirtualList>
{#if !atBottom}
  <button class="latest btn" onclick={() => list.toBottom()}>↓ Jump to latest</button>
{/if}
</div>

<style>
  .wrap {
    position: relative;
    height: 100%;
  }
  .latest {
    position: absolute;
    right: 16px;
    bottom: 12px;
    padding: 4px 12px;
    border-radius: 14px;
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.3);
  }
  .older {
    text-align: center;
    padding: 6px;
    color: var(--fg-dim);
    font-size: 0.9em;
  }
  .day {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 4px;
    color: var(--fg-dim);
    font-size: 0.85em;
  }
  .day::before,
  .day::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--border);
  }
  .empty {
    margin: 0;
    padding: 16px;
    color: var(--fg-dim);
  }
</style>
