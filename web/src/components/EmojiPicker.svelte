<script lang="ts">
  import { loadEmoji, loadRecent, rememberEmoji, searchEmoji, type Emoji } from '../lib/emoji'
  import { t } from '../lib/i18n.svelte'

  let { onpick, onclose }: { onpick: (char: string) => void; onclose: () => void } = $props()

  let query = $state('')
  let all = $state<Emoji[]>([])
  let groups = $state<string[]>([])
  let group = $state('')
  let ready = $state(false)
  let recent = $state(loadRecent())
  let search: HTMLInputElement

  const shown = $derived<Emoji[]>(query.trim() ? searchEmoji(all, query) : all.filter((e) => e.group === group))
  const nameOf = (c: string) => all.find((e) => e.char === c)?.name ?? c

  // The list is a separate download, fetched the first time the picker (or a :shortcode:) needs it.
  void loadEmoji().then((d) => {
    all = d.list
    groups = d.groups
    group = d.groups[0]!
    ready = true
  })

  $effect(() => search?.focus())

  function pick(char: string, keepOpen: boolean) {
    recent = rememberEmoji(char)
    onpick(char)
    if (!keepOpen) onclose()
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onclose()
    } else if (e.key === 'Enter' && shown[0]) {
      e.preventDefault()
      pick(shown[0].char, e.shiftKey)
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="picker" role="dialog" aria-label={t('emoji.title')} tabindex="-1" {onkeydown}>
  <input bind:this={search} bind:value={query} class="search" placeholder={t('emoji.search')} aria-label={t('emoji.search')} autocomplete="off" spellcheck="false" />

  {#if !query.trim()}
    {#if recent.length}
      <div class="label">{t('emoji.recent')}</div>
      <div class="grid" data-testid="emoji-recent">
        {#each recent as c (c)}
          <button class="e" title={nameOf(c)} aria-label={nameOf(c)} onclick={(ev) => pick(c, ev.shiftKey)}>{c}</button>
        {/each}
      </div>
    {/if}
    <div class="tabs" role="tablist">
      {#each groups as g (g)}
        <button role="tab" aria-selected={g === group} class:on={g === group} title={g} onclick={() => (group = g)}>{g.split(' ')[0]}</button>
      {/each}
    </div>
  {/if}

  <div class="grid body" data-testid="emoji-grid">
    {#each shown as e (e.char)}
      <button class="e" title={e.name} aria-label={e.name} onclick={(ev) => pick(e.char, ev.shiftKey)}>{e.char}</button>
    {:else}
      <p class="none">{ready ? t('emoji.none', { query }) : t('emoji.loading')}</p>
    {/each}
  </div>
  <div class="hint">{t('emoji.hint')}</div>
</div>

<style>
  .picker {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 10px;
    z-index: 20;
    width: min(340px, calc(100vw - 20px));
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .search {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    padding: 5px 8px;
  }
  .label,
  .hint {
    color: var(--fg-dim);
    font-size: 0.75em;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }
  .tabs button {
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 0.8em;
    color: var(--fg-dim);
  }
  .tabs button.on {
    background: var(--bg-active);
    color: var(--fg);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 2px;
  }
  .body {
    max-height: 190px;
    min-height: 60px;
    overflow-y: auto;
  }
  .e {
    font-size: 1.35em;
    line-height: 1.5;
    border-radius: 6px;
  }
  .e:hover,
  .e:focus-visible {
    background: var(--bg-hover);
  }
  .none {
    grid-column: 1 / -1;
    margin: 6px;
    color: var(--fg-dim);
  }
</style>
