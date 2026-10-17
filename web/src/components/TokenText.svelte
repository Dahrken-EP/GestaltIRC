<script lang="ts">
  import type { Token } from '../lib/render'

  let { tokens, onchannel }: { tokens: Token[]; onchannel?: (name: string) => void } = $props()
</script>

{#each tokens as t, i (i)}
  {#if t.type === 'link'}
    <a href={t.href} target="_blank" rel="noopener noreferrer nofollow" class:bold={t.bold} class:italic={t.italic} class:underline={t.underline} class:strike={t.strike}>{t.text}</a>
  {:else if t.type === 'channel'}
    <button class="chan" onclick={() => onchannel?.(t.text)}>{t.text}</button>
  {:else}
    <span
      class:mention={t.type === 'mention'}
      class:bold={t.bold}
      class:italic={t.italic}
      class:underline={t.underline}
      class:strike={t.strike}
      class:mono={t.mono}>{t.text}</span
    >
  {/if}
{/each}

<style>
  .bold {
    font-weight: 700;
  }
  .italic {
    font-style: italic;
  }
  .underline {
    text-decoration: underline;
  }
  .strike {
    text-decoration: line-through;
  }
  .mono {
    font-family: var(--mono);
  }
  .mention {
    font-weight: 600;
  }
  .chan {
    color: var(--accent);
    text-decoration: underline dotted;
  }
</style>
