<script lang="ts">
  import { app } from '../lib/app.svelte'

  const menu = $derived(app.serverMenu)
  const info = $derived(app.configured.find((n) => n.name === menu?.name))
  let confirming = $state(false)
  let busy = $state(false)
  let error = $state('')

  // A fresh menu starts without the "are you sure" step.
  $effect(() => {
    void menu?.name
    confirming = false
    error = ''
  })

  const close = () => (app.serverMenu = null)

  async function run(job: () => Promise<void>) {
    busy = true
    error = ''
    try {
      await job()
    } catch (e) {
      error = e instanceof Error ? e.message : 'That did not work.'
    } finally {
      busy = false
    }
  }

  // Keep the menu on screen near the edge.
  const left = $derived(Math.min(menu?.x ?? 0, (typeof innerWidth === 'number' ? innerWidth : 800) - 230))
  const top = $derived(Math.min(menu?.y ?? 0, (typeof innerHeight === 'number' ? innerHeight : 600) - 200))
</script>

<svelte:window onkeydown={(e) => menu && e.key === 'Escape' && close()} />

{#if menu && info}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={close}>
    <div class="menu" role="menu" tabindex="-1" aria-label="Server {info.name}" style:left="{left}px" style:top="{top}px" onclick={(e) => e.stopPropagation()}>
      <div class="title">
        <strong>{info.name}</strong>
        <span class="dim">{info.host}{info.enabled ? '' : ' · off'}</span>
      </div>
      {#if confirming}
        <p class="ask">Remove {info.name} and its saved history?</p>
        <div class="row">
          <button class="btn danger" disabled={busy} onclick={() => run(() => app.removeServer(info.name))}>Remove</button>
          <button class="btn" onclick={() => (confirming = false)}>Keep it</button>
        </div>
      {:else}
        <button role="menuitem" onclick={() => app.openServerDialog(info.name)}>Edit server…</button>
        <button role="menuitem" disabled={busy} onclick={() => run(() => app.setServerEnabled(info.name, !info.enabled))}>
          {info.enabled ? 'Switch off' : 'Switch on'}
        </button>
        <button role="menuitem" class="danger" onclick={() => (confirming = true)}>Remove…</button>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 25;
  }
  .menu {
    position: fixed;
    width: 210px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  }
  .title {
    display: flex;
    flex-direction: column;
    padding: 6px 8px 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .dim {
    color: var(--fg-dim);
    font-size: 0.85em;
  }
  button[role='menuitem'] {
    text-align: left;
    padding: 6px 8px;
    background: none;
    border: 0;
    border-radius: 4px;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }
  button[role='menuitem']:hover {
    background: var(--bg-hover);
  }
  .danger {
    color: var(--danger);
  }
  .ask {
    margin: 4px 8px;
    font-size: 0.9em;
  }
  .row {
    display: flex;
    gap: 6px;
    padding: 4px 8px 6px;
  }
  .error {
    color: var(--danger);
    margin: 4px 8px;
    font-size: 0.85em;
  }
</style>
