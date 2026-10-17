<script lang="ts">
  import { onMount } from 'svelte'
  import type { Buffer, NetworkState } from '../lib/network.svelte'
  import MessageLine from './MessageLine.svelte'

  let { net, buf, onnick, onchannel }: {
    net: NetworkState
    buf: Buffer
    onnick: (nick: string) => void
    onchannel: (name: string) => void
  } = $props()

  let el: HTMLDivElement
  let stick = true
  let renderedFirst: number | undefined
  let heightBefore = 0

  function onscroll() {
    stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 40 && buf.messages.length) net.loadOlder(buf)
  }

  // Remember the height before new rows render, so loading older messages
  // above the view does not make the page jump.
  $effect.pre(() => {
    void buf.messages
    if (el) heightBefore = el.scrollHeight
  })

  $effect(() => {
    const list = buf.messages
    if (!el) return
    const first = list[0]?.id
    if (stick) el.scrollTop = el.scrollHeight
    else if (first !== renderedFirst && renderedFirst !== undefined) el.scrollTop += el.scrollHeight - heightBefore
    renderedFirst = first
  })

  onMount(() => {
    el.scrollTop = el.scrollHeight
    renderedFirst = buf.messages[0]?.id
  })

  function dayLabel(t: number): string {
    return new Date(t).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }
  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
</script>

<div class="pane" bind:this={el} {onscroll} role="log" aria-live="polite" aria-label="Messages in {buf.name || net.label}">
  {#if buf.kind !== 'status'}
    <div class="older">
      {#if buf.historyLoading}
        <span>Loading…</span>
      {:else if buf.historyExhausted}
        <span>Start of history</span>
      {:else}
        <button class="btn" onclick={() => net.loadOlder(buf)}>Load older messages</button>
      {/if}
    </div>
  {/if}

  {#each buf.messages as msg, i (msg.id)}
    {@const prev = buf.messages[i - 1]}
    {#if !prev || !sameDay(prev.time, msg.time)}
      <div class="day"><span>{dayLabel(msg.time)}</span></div>
    {/if}
    <MessageLine {msg} {prev} {net} {onnick} {onchannel} />
  {/each}

  {#if buf.messages.length === 0 && buf.kind === 'status'}
    <p class="empty">Type /help for commands, or /join #channel to join one.</p>
  {/if}
</div>

<style>
  .pane {
    height: 100%;
    overflow-y: auto;
    padding: 4px 0 8px;
    overflow-anchor: none;
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
    margin: 8px 12px 4px;
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
    margin: 16px;
    color: var(--fg-dim);
  }
</style>
