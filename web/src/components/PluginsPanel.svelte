<script lang="ts">
  import { EXAMPLE_PLUGIN } from '../lib/plugins/examples'
  import { parseBundle } from '../lib/plugins/manifest'
  import { plugins } from '../lib/plugins/manager.svelte'
  import { PERMISSION_TEXT, type Manifest, type Permission } from '../lib/plugins/types'
  import RegistryPanel from './RegistryPanel.svelte'

  let text = $state('')
  let error = $state('')
  /** A plugin that was read but not installed yet: the user is deciding what to allow. */
  let review = $state<{ manifest: Manifest; replaces: string | null } | null>(null)
  let allow = $state<Record<string, boolean>>({})
  let open = $state<string | null>(null)

  function read() {
    error = ''
    const r = parseBundle(text)
    if (!r.ok) {
      error = r.error
      review = null
      return
    }
    const existing = plugins.entries.find((e) => e.plugin.manifest.name === r.plugin.manifest.name)
    review = { manifest: r.plugin.manifest, replaces: existing ? existing.plugin.manifest.version : null }
    allow = Object.fromEntries(r.plugin.manifest.permissions.map((p) => [p, true]))
  }

  function install() {
    const granted = Object.entries(allow).filter(([, on]) => on).map(([p]) => p as Permission)
    const r = plugins.install(text, granted)
    if (!r.ok) {
      error = r.error
      return
    }
    review = null
    text = ''
  }

  async function pick(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (file.size > 300_000) {
      error = 'That file is too large to be a plugin.'
      return
    }
    text = await file.text()
    read()
  }

  const when = (t: number) => new Date(t).toLocaleTimeString()
</script>

<div class="plugins">
  <p class="note">
    A plugin is code that runs in your browser, in a sandbox with no access to the page or the network. It can only do what
    you allow here. Plugins, and what they store, are kept on your bouncer account, so they follow you to other browsers.
  </p>

  {#if plugins.entries.length === 0}
    <p class="note">No plugins installed.</p>
  {/if}
  <ul class="list">
    {#each plugins.entries as e (e.plugin.manifest.name)}
      <li data-plugin={e.plugin.manifest.name} data-status={e.status}>
        <div class="head">
          <strong>{e.plugin.manifest.name}</strong>
          <span class="dim">{e.plugin.manifest.version}</span>
          <span class="badge {e.status}" data-testid="plugin-status">{e.status === 'failed' ? 'stopped' : e.status}</span>
          <span class="grow"></span>
          <button class="btn" onclick={() => plugins.setEnabled(e.plugin.manifest.name, !e.plugin.enabled)}>
            {e.plugin.enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button class="btn" onclick={() => plugins.remove(e.plugin.manifest.name)}>Remove</button>
        </div>
        {#if e.plugin.manifest.description}<div class="dim">{e.plugin.manifest.description}</div>{/if}
        {#if e.error}<div class="error" role="alert">Stopped: {e.error}</div>{/if}
        <div class="dim small">
          Allowed: {e.plugin.granted.length ? e.plugin.granted.join(', ') : 'nothing'}
          {#if e.plugin.manifest.permissions.length > e.plugin.granted.length}
            · Not allowed: {e.plugin.manifest.permissions.filter((p) => !e.plugin.granted.includes(p)).join(', ')}
          {/if}
        </div>
        {#if e.aliases.length}<div class="small">Commands: {e.aliases.map((a) => '/' + a).join(' ')}</div>{/if}
        <button class="link" aria-expanded={open === e.plugin.manifest.name} onclick={() => (open = open === e.plugin.manifest.name ? null : e.plugin.manifest.name)}>
          {open === e.plugin.manifest.name ? 'Hide log' : `Log (${e.logs.length})`}
        </button>
        {#if open === e.plugin.manifest.name}
          <ol class="log" data-testid="plugin-log">
            {#each e.logs as l, i (i)}
              <li class={l.kind}><time>{when(l.time)}</time> {l.text}</li>
            {:else}
              <li class="dim">Nothing logged.</li>
            {/each}
          </ol>
        {/if}
      </li>
    {/each}
  </ul>

  {#if review}
    <div class="review" role="group" aria-label="Allow this plugin">
      <strong>{review.manifest.name}</strong> <span class="dim">{review.manifest.version}</span>
      {#if review.replaces}<div class="dim">This replaces version {review.replaces}.</div>{/if}
      {#if review.manifest.description}<div>{review.manifest.description}</div>{/if}
      {#if review.manifest.permissions.length === 0}
        <div class="dim">It asks for no permissions: it can only add commands that print nothing.</div>
      {:else}
        <div class="dim">It asks to:</div>
        {#each review.manifest.permissions as p (p)}
          <label class="perm"><input type="checkbox" bind:checked={allow[p]} /> {PERMISSION_TEXT[p]}</label>
        {/each}
      {/if}
      <div class="row">
        <button class="btn primary" onclick={install}>Install</button>
        <button class="btn" onclick={() => (review = null)}>Cancel</button>
      </div>
    </div>
  {:else}
    <label>
      Add a plugin
      <textarea rows="5" bind:value={text} placeholder="Paste the plugin here (a JSON document), or choose a file" spellcheck="false" data-testid="plugin-text"></textarea>
    </label>
    <div class="row">
      <button class="btn primary" disabled={!text.trim()} onclick={read}>Review…</button>
      <label class="btn filebtn">Choose file…<input type="file" accept=".json,application/json" onchange={pick} hidden /></label>
      <button class="btn" onclick={() => ((text = EXAMPLE_PLUGIN), (error = ''))}>Use the example</button>
    </div>
  {/if}
  {#if error}<p class="error" role="alert" data-testid="plugin-error">{error}</p>{/if}

  <hr class="sep" />

  <h3>Plugin registry</h3>
  <p class="note">
    Curated plugins you can install with one click. They run in the same sandbox and only receive the permissions
    you grant. Verified plugins are maintained by the Gestalt project.
  </p>
  <RegistryPanel />
</div>

<style>
  .plugins {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .note,
  .dim {
    color: var(--fg-dim);
    font-size: 0.9em;
    margin: 0;
  }
  .small {
    font-size: 0.85em;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .list li {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
    display: grid;
    gap: 3px;
  }
  .head,
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  .badge {
    font-size: 0.8em;
    border-radius: 8px;
    padding: 0 8px;
    border: 1px solid var(--border);
  }
  .badge.running {
    border-color: var(--ok);
    color: var(--ok);
  }
  .badge.failed {
    border-color: var(--danger);
    color: var(--danger);
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
  .review {
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 8px;
    display: grid;
    gap: 6px;
  }
  .perm {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .link {
    color: var(--accent);
    text-decoration: underline;
    font-size: 0.85em;
    justify-self: start;
  }
  .log {
    margin: 0;
    padding: 4px 6px;
    list-style: none;
    max-height: 10em;
    overflow-y: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.8em;
    background: var(--bg);
    border-radius: 4px;
  }
  .log .error {
    color: var(--danger);
  }
  .log time {
    color: var(--fg-dim);
  }
  .filebtn {
    cursor: pointer;
  }
  textarea {
    width: 100%;
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
  }
</style>
