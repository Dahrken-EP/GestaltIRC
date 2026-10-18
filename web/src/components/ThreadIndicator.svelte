<script lang="ts">
  import { settings } from '../lib/settings.svelte'
  import type { Buffer } from '../lib/network.svelte'
  import type { ChatMessage } from '../lib/network.svelte'

  let { msg, buf }: { msg: ChatMessage; buf: Buffer } = $props()

  /** How many direct replies this message has. */
  const count = $derived.by(() => {
    if (!msg.msgid) return 0
    return buf.replyCount(msg.msgid)
  })

  function viewThread() {
    const parent = msg.replyTo ? buf.byMsgId(msg.replyTo) : undefined
    if (parent?.msgid) {
      // Scroll to / highlight the parent message by asking the pane to focus it.
      ;(window as unknown as { gestaltThreadFocus?: (msgid: string) => void }).gestaltThreadFocus?.(parent.msgid)
    }
  }
</script>

{#if settings.threadIndicators && count > 0}
  <button
    class="thread"
    aria-label="{count} {count === 1 ? 'reply' : 'replies'} to this message"
    title="{count} {count === 1 ? 'reply' : 'replies'}"
    onclick={viewThread}
  >
    <span class="badge">{count}</span>
    <span class="label">{count === 1 ? 'reply' : 'replies'}</span>
  </button>
{/if}

<style>
  .thread {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-hover);
    color: var(--fg-dim);
    font-size: 0.75em;
    cursor: pointer;
    line-height: 1.4;
  }
  .thread:hover {
    background: var(--bg-panel);
    border-color: var(--accent);
    color: var(--fg);
  }
  .badge {
    display: inline-block;
    min-width: 1.2em;
    text-align: center;
    font-weight: 700;
    color: var(--fg);
  }
  .label {
    font-weight: 600;
  }
</style>
