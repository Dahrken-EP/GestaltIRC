<script lang="ts">
  import { plugins } from '../lib/plugins/manager.svelte'

  // The window a plugin asked for. The page draws it, and says whose it is, so a plugin cannot dress one up as the
  // client's own. Several may be waiting; they are shown one at a time, oldest first.
  const current = $derived(plugins.dialogs[0])
  const waiting = $derived(plugins.dialogs.length - 1)
  let value = $state('')
  let field: HTMLInputElement | undefined = $state()
  let ok: HTMLButtonElement | undefined = $state()
  let shown = 0
  let shownAt = 0
  // Keys pressed in the moment a window appears were meant for whatever the user was doing, such as the Enter that
  // sends a message, so for a short time the window takes no answer.
  const SETTLE_MS = 600
  const settled = () => Date.now() - shownAt >= SETTLE_MS

  // A new window starts with its own text and focus.
  $effect(() => {
    if (!current || current.id === shown) return
    shown = current.id
    shownAt = Date.now()
    value = current.value
    queueMicrotask(() => (current?.kind === 'prompt' ? field : ok)?.focus())
  })

  const cancel = () => current && settled() && plugins.answerDialog(current.id, { ok: false, value: '' })
  const accept = () => current && settled() && plugins.answerDialog(current.id, { ok: true, value: current.kind === 'prompt' ? value : '' })

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // For an alert there is nothing to decline, so Escape reads it.
      if (current?.kind === 'alert') accept()
      else cancel()
    }
  }
</script>

{#if current}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="backdrop" role="presentation" {onkeydown}>
    <div class="card" role="alertdialog" aria-modal="true" aria-labelledby="plugin-dialog-from" aria-describedby="plugin-dialog-text" data-testid="plugin-dialog">
      <p class="from" id="plugin-dialog-from">
        The plugin <strong>{current.plugin}</strong> {current.kind === 'alert' ? 'says' : 'asks'}:
      </p>
      <p class="text" id="plugin-dialog-text">{current.text}</p>
      {#if current.kind === 'prompt'}
        <form onsubmit={(e) => (e.preventDefault(), accept())}>
          <input bind:this={field} bind:value aria-label="Your answer" autocomplete="off" spellcheck="false" />
        </form>
        <p class="dim">What you type goes to the plugin. Do not enter a password.</p>
      {/if}
      <footer>
        <button class="link" type="button" onclick={() => current && plugins.stopFromDialog(current.id)}>Stop this plugin</button>
        {#if waiting > 0}<span class="dim">{waiting} more waiting</span>{/if}
        <span class="grow"></span>
        {#if current.kind !== 'alert'}<button type="button" class="btn" onclick={cancel}>Cancel</button>{/if}
        <button type="button" class="btn primary" bind:this={ok} onclick={accept}>OK</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.45);
  }
  .card {
    width: min(420px, calc(100% - 24px));
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
  }
  p {
    margin: 0;
  }
  .from,
  .dim {
    color: var(--fg-dim);
    font-size: 0.85em;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 40vh;
    overflow-y: auto;
  }
  input {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    padding: 5px 8px;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .link {
    color: var(--fg-dim);
    font-size: 0.85em;
    text-decoration: underline;
  }
</style>
