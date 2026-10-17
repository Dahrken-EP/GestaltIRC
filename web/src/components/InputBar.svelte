<script lang="ts">
  import { applyCompletion, findCompletions, type Completion } from '../lib/complete'
  import type { Buffer, ChatMessage, NetworkState } from '../lib/network.svelte'

  let { net, buf, reply, oncancelreply }: {
    net: NetworkState
    buf: Buffer
    /** The message being answered, if the user chose "reply". */
    reply: ChatMessage | null
    oncancelreply: () => void
  } = $props()

  const COMMANDS = [
    'help', 'join', 'part', 'quit', 'nick', 'msg', 'query', 'notice', 'me', 'topic', 'names', 'list', 'whois',
    'whowas', 'who', 'mode', 'kick', 'ban', 'unban', 'invite', 'away', 'back', 'ctcp', 'ping', 'time',
    'version', 'motd', 'stats', 'links', 'raw', 'clear',
  ]

  let text = $state('')
  let el: HTMLTextAreaElement
  const history: string[] = []
  let histIdx = -1
  let draft = ''
  // Repeated Tab presses cycle through matches, each applied to the text as it was before the first.
  let cycle: { original: string; c: Completion; i: number; applied: string } | null = null

  function grow() {
    el.style.height = 'auto'
    const line = parseFloat(getComputedStyle(el).lineHeight) || 18
    el.style.height = Math.min(el.scrollHeight, line * 5 + 12) + 'px'
  }

  $effect(() => {
    void text
    if (el) grow()
  })

  // Focus the input when the user switches buffer.
  $effect(() => {
    void buf.key
    el?.focus()
  })

  function send() {
    const value = text.replace(/\s+$/, '')
    if (!value) return
    if (history[history.length - 1] !== value) history.push(value)
    if (history.length > 100) history.shift()
    histIdx = -1
    text = ''
    net.submit(value, reply?.msgid)
    oncancelreply()
  }

  // Tell the channel we are typing, unless this is a command or the box was emptied.
  function oninput() {
    if (!text.trim()) net.sendTyping(buf, 'done')
    else if (!text.startsWith('/')) net.sendTyping(buf, 'active')
  }

  function complete(e: KeyboardEvent) {
    e.preventDefault()
    if (cycle && text === cycle.applied) {
      cycle.i = (cycle.i + (e.shiftKey ? -1 : 1) + cycle.c.matches.length) % cycle.c.matches.length
    } else {
      const c = findCompletions(text, el.selectionStart, {
        nicks: [...buf.members.values()].map((m) => m.nick),
        channels: net.buffers.filter((b) => b.kind === 'channel').map((b) => b.name),
        commands: COMMANDS,
        chanTypes: net.chanTypes,
      })
      if (!c) return
      cycle = { original: text, c, i: 0, applied: '' }
    }
    const out = applyCompletion(cycle.original, cycle.c, cycle.c.matches[cycle.i]!)
    text = out.text
    cycle.applied = out.text
    queueMicrotask(() => el.setSelectionRange(out.caret, out.caret))
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && reply) {
      e.preventDefault()
      oncancelreply()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      complete(e)
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && !text.includes('\n') && history.length) {
      e.preventDefault()
      if (histIdx === -1) {
        draft = text
        histIdx = history.length
      }
      histIdx = Math.max(0, histIdx - 1)
      text = history[histIdx]!
    } else if (e.key === 'ArrowDown' && histIdx !== -1 && !text.includes('\n')) {
      e.preventDefault()
      histIdx++
      if (histIdx >= history.length) {
        histIdx = -1
        text = draft
      } else {
        text = history[histIdx]!
      }
    }
  }

  const placeholder = $derived(
    buf.kind === 'status' ? 'Type a command, e.g. /join #channel' : `Message ${buf.name}`,
  )

  const typingText = $derived.by(() => {
    const who = buf.typing
    if (who.length === 0) return ''
    if (who.length === 1) return `${who[0]} is typing…`
    if (who.length === 2) return `${who[0]} and ${who[1]} are typing…`
    return 'Several people are typing…'
  })
</script>

<form class="input" onsubmit={(e) => { e.preventDefault(); send() }}>
  {#if reply}
    <div class="replying">
      <span>Replying to <strong>{reply.nick}</strong>: {reply.text.length > 80 ? reply.text.slice(0, 79) + '…' : reply.text}</span>
      <button type="button" aria-label="Cancel reply" title="Cancel reply (Esc)" onclick={oncancelreply}>×</button>
    </div>
  {/if}
  <label class="visually-hidden" for="msg-input">Message</label>
  <textarea
    id="msg-input"
    bind:this={el}
    bind:value={text}
    {onkeydown}
    {oninput}
    {placeholder}
    rows="1"
    spellcheck="true"
    autocomplete="off"
    autocapitalize="off"
    disabled={net.status !== 'connected'}
  ></textarea>
  <div class="typing" aria-live="polite">{typingText}</div>
</form>

<style>
  .input {
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg);
  }
  textarea {
    display: block;
    width: 100%;
    resize: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    padding: 5px 8px;
    line-height: 1.35;
    max-height: 9em;
  }
  textarea:disabled {
    opacity: 0.6;
  }
  .typing {
    min-height: 1.3em;
    padding-top: 2px;
    font-size: 0.85em;
    color: var(--fg-dim);
  }
  .replying {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 8px;
    margin-bottom: 4px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 4px;
    font-size: 0.9em;
    color: var(--fg-dim);
    background: var(--bg-panel);
  }
  .replying span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .replying button {
    font-size: 1.2em;
    line-height: 1;
    padding: 0 4px;
  }
</style>
