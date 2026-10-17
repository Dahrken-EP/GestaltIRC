<script lang="ts">
  import type { Buffer, ChatMessage, NetworkState } from '../lib/network.svelte'
  import MessageLine from './MessageLine.svelte'
  import VirtualList from './VirtualList.svelte'

  let { net, buf, onnick, onchannel, onreply }: {
    net: NetworkState
    buf: Buffer
    onnick: (nick: string) => void
    onchannel: (name: string) => void
    onreply: (msg: ChatMessage) => void
  } = $props()

  type Row =
    | { key: string; kind: 'older' }
    | { key: string; kind: 'empty' }
    | { key: string; kind: 'day'; time: number }
    | { key: string; kind: 'msg'; msg: ChatMessage; prev: ChatMessage | undefined }

  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

  const rows = $derived.by(() => {
    const out: Row[] = []
    if (buf.onNetwork) out.push({ key: 'older', kind: 'older' })
    const list = buf.messages
    if (list.length === 0 && buf.kind === 'status') out.push({ key: 'empty', kind: 'empty' })
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
</script>

<VirtualList items={rows} estimate={22} label="Messages in {buf.name || net.label}" onreachtop={() => buf.messages.length && net.loadOlder(buf)}>
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
    {:else if row.kind === 'day'}
      <div class="day"><span>{dayLabel(row.time)}</span></div>
    {:else}
      <MessageLine msg={row.msg} prev={row.prev} {net} {buf} {onnick} {onchannel} {onreply} />
    {/if}
  {/snippet}
</VirtualList>

<style>
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
