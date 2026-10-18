<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '../lib/i18n.svelte'

  let { value = $bindable(''), onclose }: { value: string; onclose: () => void } = $props()

  let input: HTMLInputElement

  onMount(() => {
    input.focus()
    input.select()
  })

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onclose()
    }
  }
</script>

<div class="bar" role="search">
  <input
    bind:this={input}
    bind:value
    {onkeydown}
    type="search"
    placeholder={t('search.placeholder')}
    aria-label={t('search.aria')}
    autocomplete="off"
    spellcheck="false"
  />
  <button class="icon" title={t('search.close_title')} aria-label={t('search.close')} onclick={onclose}>×</button>
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
</style>
