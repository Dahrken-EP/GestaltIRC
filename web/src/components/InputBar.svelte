<script lang="ts">
  import { applyCompletion, findCompletions, type Completion } from '../lib/complete'
  import type { Buffer, NetworkState } from '../lib/network.svelte'

  let { net, buf }: { net: NetworkState; buf: Buffer } = $props()

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
    net.submit(value)
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
</script>

<form class="input" onsubmit={(e) => { e.preventDefault(); send() }}>
  <label class="visually-hidden" for="msg-input">Message</label>
  <textarea
    id="msg-input"
    bind:this={el}
    bind:value={text}
    {onkeydown}
    {placeholder}
    rows="1"
    spellcheck="true"
    autocomplete="off"
    autocapitalize="off"
    disabled={net.status !== 'connected'}
  ></textarea>
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
</style>
