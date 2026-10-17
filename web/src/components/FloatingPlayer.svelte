<script lang="ts">
  import { embedSrc } from '../lib/media'
  import { player } from '../lib/player.svelte'
  import { settings } from '../lib/settings.svelte'

  const now = $derived(player.current)
</script>

<!-- Outside the buffer, so changing channel, server or scroll position does not take the video down. -->
{#if now && settings.embeds}
  <aside class="floating" aria-label="Video player" data-testid="floating-player">
    <header>
      <span class="title" title={now.title}>{now.title}</span>
      <button class="x" onclick={() => player.stop()} aria-label="Close the player" title="Close the player">×</button>
    </header>
    <!-- YouTube refuses to play (error 153) for a page that sends no Referer, so the player gets this site's address and no more. -->
    {#key now.href}
      <iframe
        src={embedSrc(now.kind, now.id)}
        title={now.title}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation"
      ></iframe>
    {/key}
  </aside>
{/if}

<style>
  .floating {
    position: fixed;
    right: 16px;
    bottom: 76px;
    z-index: 20;
    width: min(360px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.4);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 10px;
    font-size: 0.85em;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-dim);
  }
  .x {
    background: none;
    border: 0;
    color: var(--fg-dim);
    font-size: 1.3em;
    cursor: pointer;
  }
  iframe {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 0;
    background: #000;
  }
</style>
