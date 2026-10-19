<script lang="ts">
  import { applyCompletion, findCompletions, type Completion } from '../lib/complete'
  import { emojiIfLoaded, expandShortcodes, loadEmoji, matchShortcodes, shortcodeQueryAt } from '../lib/emoji'
  import type { Buffer, ChatMessage, NetworkState } from '../lib/network.svelte'
  import { api, ApiError } from '../lib/api'
  import { t } from '../lib/i18n.svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import EmojiPicker from './EmojiPicker.svelte'
  import { ensureUploadInfo, uploadLimits, uploadsEnabled } from '../lib/uploads.svelte'

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

  // What the user has typed, kept per buffer: every channel and DM has its own
  // draft, and switching never carries one buffer's text into another. It is a
  // SvelteMap, not a Map in $state: editing a Map in place does not reach what
  // reads it, and the box would keep showing typed text that nothing sent ever.
  const drafts = new SvelteMap<string, string>()
  const boxKey = $derived(`${net.id}:${buf.key}`)
  const text = $derived(drafts.get(boxKey) ?? '')
  /** The write side of `text`, always counted to the buffer shown now. */
  const setDraft = (v: string) => {
    if (v) drafts.set(boxKey, v)
    else drafts.delete(boxKey)
  }
  let picking = $state(false)
  let el: HTMLTextAreaElement
  // :shortcode: completion. The emoji list is fetched the first time a colon is typed.
  let codes = $state<Map<string, string> | null>(emojiIfLoaded()?.byCode ?? null)
  let caret = $state(0)
  let picked = $state(0)
  let dismissed = $state('')
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

  // Focus the input when the user switches buffer, and keep the caret sane:
  // the kept draft may be shorter than the caret remembered from the last buffer.
  $effect(() => {
    void buf.key
    el?.focus()
    if (caret > text.length) caret = text.length
  })

  const suggestions = $derived.by(() => {
    if (!codes) return null
    const at = shortcodeQueryAt(text, caret)
    if (!at || dismissed === `${at.start}:${at.query}`) return null
    const matches = matchShortcodes(codes, at.query)
    return matches.length ? { at, matches } : null
  })

  function updateCaret() {
    caret = el?.selectionStart ?? text.length
    picked = 0
  }

  /** Puts the chosen emoji where the half-typed :shortcode was. */
  function accept(i: number) {
    const s = suggestions
    if (!s) return
    const char = s.matches[i]!.char
    setDraft(text.slice(0, s.at.start) + char + text.slice(caret))
    const to = s.at.start + char.length
    caret = to
    queueMicrotask(() => {
      el.focus()
      el.setSelectionRange(to, to)
    })
  }

  function send() {
    let value = text.replace(/\s+$/, '')
    if (codes && !/^\/raw\s/i.test(value)) value = expandShortcodes(codes, value)
    if (!value) return
    if (history[history.length - 1] !== value) history.push(value)
    if (history.length > 100) history.shift()
    histIdx = -1
    setDraft('')
    net.submit(value, reply?.msgid)
    oncancelreply()
  }

  // Tell the channel we are typing, unless this is a command or the box was emptied. The
  // browser has already put the typed text in the textarea; nothing keeps the per-buffer
  // draft in step except this: without it, the state's read back stays empty and pressing
  // Enter would send nothing.
  function oninput() {
    if (el) setDraft(el.value)
    updateCaret()
    if (text.includes(':') && !codes) void loadEmoji().then((d) => (codes = d.byCode))
    // A closing colon turns :name: into the emoji.
    if (codes && text[caret - 1] === ':') {
      const head = expandShortcodes(codes, text.slice(0, caret))
      if (head !== text.slice(0, caret)) {
        const rest = text.slice(caret)
        setDraft(head + rest)
        const to = head.length
        caret = to
        queueMicrotask(() => el.setSelectionRange(to, to))
      }
    }
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
    setDraft(out.text)
    cycle.applied = out.text
    queueMicrotask(() => el.setSelectionRange(out.caret, out.caret))
  }

  /** Puts an emoji where the caret is, and leaves the caret after it. */
  function insert(char: string) {
    const at = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? at
    setDraft(text.slice(0, at) + char + text.slice(end))
    const caret = at + char.length
    queueMicrotask(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  function onkeydown(e: KeyboardEvent) {
    const s = suggestions
    if (s && !e.isComposing && !e.ctrlKey && !e.altKey) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = s.matches.length
        picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
        return
      }
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        accept(picked)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissed = `${s.at.start}:${s.at.query}`
        return
      }
    }
    if (e.key === 'e' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      picking = !picking
    } else if (e.key === 'Escape' && picking) {
      picking = false
    } else if (e.key === 'Escape' && reply) {
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
      setDraft(history[histIdx]!)
    } else if (e.key === 'ArrowDown' && histIdx !== -1 && !text.includes('\n')) {
      e.preventDefault()
      histIdx++
      if (histIdx >= history.length) {
        histIdx = -1
        setDraft(draft)
      } else {
        setDraft(history[histIdx]!)
      }
    }
  }

  const disconnected = $derived(buf.kind === 'p2p' ? buf.p2p?.state !== 'connected' : net.status !== 'connected')
  // The bouncer answers once whether it hosts files; the button only exists then.
  const uploadsHere = $derived(uploadsEnabled())
  const placeholder = $derived(
    buf.kind === 'status'
      ? t('input.type_command')
      : buf.kind === 'p2p'
        ? buf.p2p?.state === 'connected'
          ? t('input.message_direct', { name: buf.name })
          : t('input.connect_first')
        : t('input.message', { name: buf.name }),
  )

  const typingText = $derived.by(() => {
    const who = buf.typing
    if (who.length === 0) return ''
    if (who.length === 1) return t('input.typing_one', { nick: who[0] ?? '' })
    if (who.length === 2) return t('input.typing_two', { a: who[0] ?? '', b: who[1] ?? '' })
    return t('input.typing_many')
  })

  // Attached files. Only shown when the bouncer hosts uploads at all; the limits come
  // from the bouncer's own configuration, asked for once and kept.
  $effect(() => {
    void ensureUploadInfo()
  })
  let fileInput = $state<HTMLInputElement>()
  /** What is going up right now, or the last file that could not go up. */
  let note = $state<{ kind: 'busy' | 'error'; text: string } | null>(null)

  function fmtBytes(n: number): string {
    if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(n % (1 << 20) ? 1 : 0)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
    return `${n} B`
  }

  async function attach(files: FileList | null) {
    if (!files || files.length === 0) return
    const limits = uploadLimits()
    for (const file of Array.from(files)) {
      if (limits && file.size > limits.max_bytes) {
        note = { kind: 'error', text: t('upload.too_big', { name: file.name, size: fmtBytes(limits.max_bytes) }) }
        continue
      }
      note = { kind: 'busy', text: t('upload.working', { name: file.name }) }
      try {
        const res = await api.uploadFile(file)
        // The link goes in the message like any pasted address, so the user can still
        // add words around it before sending.
        insert(new URL(res.url, location.href).toString() + ' ')
        note = null
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0
        note =
          status === 413
            ? { kind: 'error', text: t('upload.too_big', { name: file.name, size: fmtBytes(limits?.max_bytes ?? 0) }) }
            : { kind: 'error', text: err instanceof Error ? err.message : t('upload.failed', { name: file.name }) }
      }
    }
    // Same file can be picked again after this.
    if (fileInput) fileInput.value = ''
  }
</script>

<form class="input" onsubmit={(e) => { e.preventDefault(); send() }}>
  {#if reply}
    <div class="replying">
      <span>{t('input.replying')} <strong>{reply.nick}</strong>: {reply.text.length > 80 ? reply.text.slice(0, 79) + '…' : reply.text}</span>
      <button type="button" aria-label={t('input.cancel_reply')} title={t('input.cancel_reply_title')} onclick={oncancelreply}>×</button>
    </div>
  {/if}
  {#if picking}
    <EmojiPicker onpick={insert} onclose={() => { picking = false; el?.focus() }} />
  {/if}
  {#if suggestions}
    <ul class="suggest" id="emoji-suggest" role="listbox" aria-label={t('emoji.title')} data-testid="emoji-suggest">
      {#each suggestions.matches as m, i (m.code)}
        <li id="emoji-suggest-{i}" role="option" aria-selected={i === picked} class:on={i === picked}>
          <button type="button" tabindex="-1" onmousedown={(e) => (e.preventDefault(), accept(i))}>
            <span class="char">{m.char}</span> :{m.code}:
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <label class="visually-hidden" for="msg-input">{t('input.label')}</label>
  <div class="field">
  <textarea
    id="msg-input"
    bind:this={el}
    value={text}
    {onkeydown}
    {oninput}
    onkeyup={updateCaret}
    onclick={updateCaret}
    aria-controls={suggestions ? 'emoji-suggest' : undefined}
    aria-autocomplete="list"
    aria-activedescendant={suggestions ? `emoji-suggest-${picked}` : undefined}
    {placeholder}
    rows="1"
    spellcheck="true"
    autocomplete="off"
    autocapitalize="off"
    disabled={disconnected}
  ></textarea>
  {#if uploadsHere}
    <button type="button" class="emoji" title={t('input.attach')} aria-label={t('input.attach')} onclick={() => fileInput?.click()} disabled={disconnected}>📎</button>
    <input class="filer" type="file" bind:this={fileInput} multiple hidden onchange={(e) => attach(e.currentTarget.files)} />
  {/if}
  <button type="button" class="emoji" title={t('input.emoji_title')} aria-label={t('emoji.title')} aria-expanded={picking} onclick={() => (picking = !picking)}>😊</button>
  <button type="submit" class="send" title={t('input.send')} aria-label={t('input.send')} disabled={disconnected || !text.trim()}>➤</button>
  </div>
  <div class="typing" aria-live="polite">
    {#if note}<span class:err={note.kind === 'error'}>{note.text}</span>{:else}{typingText}{/if}
  </div>
</form>

<style>
  .input {
    position: relative;
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg);
  }
  .field {
    display: flex;
    gap: 6px;
    align-items: flex-end;
  }
  .emoji {
    flex: none;
    font-size: 1.2em;
    padding: 3px 6px;
    border-radius: 6px;
  }
  .emoji:hover {
    background: var(--bg-hover);
  }
  .emoji:disabled {
    opacity: 0.4;
  }
  .send {
    flex: none;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 1.05em;
    color: var(--accent);
  }
  .send:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .send:disabled {
    opacity: 0.35;
  }
  .err {
    color: var(--danger, #d05050);
  }
  textarea {
    flex: 1;
    min-width: 0;
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
  .suggest {
    position: absolute;
    bottom: calc(100% - 4px);
    left: 10px;
    z-index: 20;
    min-width: 200px;
    max-width: calc(100% - 20px);
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  }
  .suggest button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 3px 8px;
    border-radius: 5px;
  }
  .suggest li.on button,
  .suggest button:hover {
    background: var(--bg-active);
  }
  .suggest .char {
    display: inline-block;
    width: 1.6em;
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
