<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { app, type SwitcherEntry } from '../lib/app.svelte'
  import { fuzzyFilter } from '../lib/fuzzy'

  let query = $state('')
  let picked = $state(0)
  let input: HTMLInputElement
  let list: HTMLUListElement

  const MAX = 50

  // With nothing typed, buffers that want attention come first, then the rest as they are listed.
  const results = $derived.by(() => {
    const all = app.entries
    if (!query.trim()) {
      const weight = (e: SwitcherEntry) => (e.mentions ? 2 : e.unread ? 1 : 0)
      return all.map((e, i) => ({ e, i })).sort((a, b) => weight(b.e) - weight(a.e) || a.i - b.i).map((x) => x.e).slice(0, MAX)
    }
    return fuzzyFilter(all, query, (e) => [e.name, `${e.network} ${e.name}`]).slice(0, MAX)
  })

  $effect(() => {
    void query
    picked = 0
  })

  onMount(() => input.focus())

  const close = () => (app.showSwitcher = false)

  function go(e: SwitcherEntry | undefined) {
    if (!e) return
    close()
    app.goto(e.netId, e.key)
  }

  async function move(delta: number) {
    if (!results.length) return
    picked = (picked + delta + results.length) % results.length
    await tick()
    list.children[picked]?.scrollIntoView({ block: 'nearest' })
  }

  function onkeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
    } else if (ev.key === 'ArrowDown' || (ev.key === 'n' && ev.ctrlKey)) {
      ev.preventDefault()
      void move(1)
    } else if (ev.key === 'ArrowUp' || (ev.key === 'p' && ev.ctrlKey)) {
      ev.preventDefault()
      void move(-1)
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      go(results[picked])
    } else if (ev.key === 'Tab') {
      // Keep focus in the box; the list is driven from the keyboard here.
      ev.preventDefault()
      void move(ev.shiftKey ? -1 : 1)
    }
  }

  const label = (e: SwitcherEntry) => (e.kind === 'p2p' ? `⚡ ${e.name}` : e.name)
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={close}>
  <div class="box" role="dialog" tabindex="-1" aria-modal="true" aria-label="Go to a channel or conversation" onclick={(e) => e.stopPropagation()}>
    <input
      bind:this={input}
      bind:value={query}
      {onkeydown}
      type="text"
      placeholder="Go to a channel or conversation…"
      aria-label="Go to"
      aria-controls="switcher-list"
      aria-activedescendant={results[picked] ? `sw-${picked}` : undefined}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      role="combobox"
      aria-expanded="true"
    />
    <ul id="switcher-list" role="listbox" bind:this={list}>
      {#each results as e, i (e.netId + '/' + e.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="sw-{i}"
          role="option"
          aria-selected={i === picked}
          class:picked={i === picked}
          onclick={() => go(e)}
          onmousemove={() => (picked = i)}
        >
          <span class="name">{label(e)}</span>
          <span class="net">{e.network}</span>
          {#if e.mentions}<span class="badge mention">{e.mentions}</span>{:else if e.unread}<span class="badge">{e.unread}</span>{/if}
        </li>
      {:else}
        <li class="none" role="presentation">Nothing matches “{query}”.</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: rgb(0 0 0 / 0.4);
  }
  .box {
    width: min(480px, calc(100% - 24px));
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
    overflow: hidden;
  }
  input {
    padding: 10px 12px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    font: inherit;
    outline: none;
  }
  ul {
    margin: 0;
    padding: 4px;
    list-style: none;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  li.picked {
    background: var(--bg-hover);
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .net {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-dim);
    font-size: 0.85em;
  }
  .badge {
    padding: 0 6px;
    border-radius: 8px;
    background: var(--bg-hover);
    font-size: 0.8em;
  }
  .badge.mention {
    background: var(--accent);
    color: var(--accent-fg, #fff);
  }
  .none {
    color: var(--fg-dim);
    cursor: default;
  }
</style>
