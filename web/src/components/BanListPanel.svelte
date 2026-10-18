<script lang="ts">
  import { api } from '../lib/api'
  import { settings } from '../lib/settings.svelte'

  interface BanEntry {
    mask: string
  }

  let { net, buf }: { net: any; buf: any } = $props()

  let bans = $state<string[]>([])
  let loading = $state(false)
  let newMask = $state('')
  let addError = $state('')
  let removing = $state<string | null>(null)

  async function load() {
    if (!net || !buf || buf.kind !== 'channel') {
      bans = []
      return
    }
    loading = true
    try {
      bans = await api.bans(net.name, buf.name)
    } catch {
      bans = []
    } finally {
      loading = false
    }
  }

  async function addBan() {
    const mask = newMask.trim()
    if (!mask) return
    addError = ''
    try {
      await api.banAdd(net.name, buf.name, mask)
      newMask = ''
      await load()
    } catch (e) {
      addError = e instanceof Error ? e.message : 'Failed to add ban'
    }
  }

  async function removeBan(mask: string) {
    removing = mask
    try {
      await api.banRemove(net.name, buf.name, mask)
      await load()
    } catch (e) {
      // ignore
    } finally {
      removing = null
    }
  }

  $effect(() => {
    if (net && buf && buf.kind === 'channel') {
      load()
    } else {
      bans = []
    }
  })
</script>

<div class="banlist">
  <h3>Channel bans</h3>
  {#if loading}
    <p class="note">Loading…</p>
  {:else if bans.length === 0}
    <p class="note">No bans in this channel.</p>
  {:else}
    <ul class="list">
      {#each bans as mask (mask)}
        <li class="entry">
          <span class="mask">{mask}</span>
          <button class="btn" onclick={() => removeBan(mask)} disabled={removing === mask}>
            {removing === mask ? 'Removing…' : 'Remove'}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="add">
    <input
      type="text"
      bind:value={newMask}
      placeholder="ban mask (e.g. *!*@bad.host)"
      aria-label="Ban mask"
      onkeydown={(e) => e.key === 'Enter' && addBan()}
    />
    <button class="btn" onclick={addBan} disabled={!newMask.trim()}>Add</button>
    {#if addError}<p class="error">{addError}</p>{/if}
  </div>
</div>

<style>
  .banlist {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h3 {
    margin: 0;
    font-size: 1em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
  }
  .note {
    margin: 0;
    color: var(--fg-dim);
    font-size: 0.9em;
    padding: 12px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .entry {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
  }
  .mask {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
  }
  .add {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .add input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.85em;
  }
</style>
