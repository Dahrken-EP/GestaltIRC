<script lang="ts">
  import { onMount } from 'svelte'
  import { api, ApiError, type NetworkDetail } from '../lib/api'
  import { app } from '../lib/app.svelte'
  import { blankForm, checkForm, formFromNetwork, toRequest, type NetworkForm } from '../lib/networkform'

  let networks = $state<NetworkDetail[]>([])
  let max = $state(10)
  let privateAllowed = $state(false)
  let loaded = $state(false)
  let form = $state<NetworkForm | null>(null)
  let error = $state('')
  let busy = $state(false)
  /** The network the person has asked to remove and has not yet confirmed. */
  let removing = $state<string | null>(null)
  let showMore = $state(false)

  async function load() {
    try {
      const r = await api.listNetworks()
      networks = r.networks
      max = r.max
      privateAllowed = r.private_allowed
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load your networks.'
    } finally {
      loaded = true
    }
  }

  // Connection state changes after the person has looked, so keep the list fresh while it is open.
  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), 4000)
    return () => clearInterval(timer)
  })

  function add() {
    form = blankForm(app.user)
    showMore = false
    error = ''
  }

  function edit(n: NetworkDetail) {
    form = formFromNetwork(n)
    showMore = form.ident !== '' || form.realname !== ''
    error = ''
    removing = null
  }

  async function run(job: () => Promise<unknown>): Promise<boolean> {
    busy = true
    error = ''
    try {
      await job()
      await load()
      await app.resync()
      return true
    } catch (e) {
      error = e instanceof ApiError || e instanceof Error ? e.message : 'That did not work.'
      return false
    } finally {
      busy = false
    }
  }

  async function save() {
    if (!form) return
    const problem = checkForm(form)
    if (problem) {
      error = problem
      return
    }
    const f = form
    const req = toRequest(f)
    const done = await run(() => (f.editing ? api.updateNetwork(f.editing, req) : api.addNetwork(req)))
    if (done) form = null
  }

  async function toggle(n: NetworkDetail) {
    await run(async () => {
      const f = formFromNetwork(n)
      f.enabled = !n.enabled
      await api.updateNetwork(n.name, toRequest(f))
    })
  }

  async function remove(name: string) {
    if (await run(() => api.deleteNetwork(name))) removing = null
  }

  const statusOf = (n: NetworkDetail) => (!n.enabled ? 'off' : n.connected ? 'connected' : 'connecting')
</script>

<div class="networks" data-testid="networks-panel">
  {#if !loaded}
    <p class="dim">Loading…</p>
  {:else}
    <ul class="list">
      {#each networks as n (n.name)}
        <li data-network={n.name}>
          <div class="head">
            <strong>{n.name}</strong>
            <span class="dim grow">{n.host}:{n.port}{n.tls ? '' : ' (no TLS)'}</span>
            <span class="badge {statusOf(n)}" data-testid="network-state">{statusOf(n)}</span>
          </div>
          {#if removing === n.name}
            <div class="row confirm">
              <span class="grow">Remove {n.name} and its saved history?</span>
              <button class="btn danger" disabled={busy} onclick={() => remove(n.name)}>Remove</button>
              <button class="btn" onclick={() => (removing = null)}>Keep it</button>
            </div>
          {:else}
            <div class="row">
              <button class="btn" onclick={() => edit(n)}>Edit</button>
              <button class="btn" disabled={busy} onclick={() => toggle(n)}>{n.enabled ? 'Switch off' : 'Switch on'}</button>
              <button class="btn" onclick={() => (removing = n.name)}>Remove…</button>
            </div>
          {/if}
        </li>
      {:else}
        <li class="dim">No networks yet.</li>
      {/each}
    </ul>

    {#if form}
      <form class="form" onsubmit={(e) => (e.preventDefault(), void save())} aria-label={form.editing ? `Edit ${form.editing}` : 'Add a network'}>
        <strong>{form.editing ? `Edit ${form.editing}` : 'Add a network'}</strong>
        {#if !form.editing}
          <label>Name <input bind:value={form.name} placeholder="libera" autocomplete="off" spellcheck="false" /></label>
        {/if}
        <div class="two">
          <label class="grow">Server <input bind:value={form.host} placeholder="irc.libera.chat" autocomplete="off" spellcheck="false" /></label>
          <label class="port">Port <input bind:value={form.port} inputmode="numeric" autocomplete="off" /></label>
        </div>
        <label class="check"><input type="checkbox" bind:checked={form.tls} /> Use TLS (encrypted)</label>
        <label>Nick <input bind:value={form.nick} autocomplete="off" spellcheck="false" /></label>
        <label>
          Channels to join <span class="opt">(separated by spaces)</span>
          <input bind:value={form.channels} placeholder="#general #help" autocomplete="off" spellcheck="false" />
        </label>

        {#if form.certificate}
          <p class="dim">This network logs in with a certificate, which is managed with the command line.</p>
        {:else}
          <label>
            Log in with SASL
            <select bind:value={form.sasl}>
              <option value="">No account</option>
              <option value="PLAIN">Account and password (PLAIN)</option>
              <option value="SCRAM-SHA-256">Account and password (SCRAM-SHA-256)</option>
            </select>
          </label>
          {#if form.sasl}
            <label>Account <input bind:value={form.saslUser} autocomplete="off" spellcheck="false" /></label>
            <label>
              Password
              <input
                type="password"
                bind:value={form.saslPassword}
                placeholder={form.hasSaslPassword ? 'Saved. Leave blank to keep it.' : ''}
                autocomplete="new-password"
              />
            </label>
          {/if}
        {/if}

        <button type="button" class="link" onclick={() => (showMore = !showMore)} aria-expanded={showMore}>
          {showMore ? 'Fewer options' : 'More options'}
        </button>
        {#if showMore}
          <label>
            Server password <span class="opt">(rarely needed)</span>
            <input
              type="password"
              bind:value={form.serverPassword}
              placeholder={form.hasServerPassword && !form.clearServerPassword ? 'Saved. Leave blank to keep it.' : ''}
              autocomplete="new-password"
            />
          </label>
          {#if form.hasServerPassword}
            <label class="check"><input type="checkbox" bind:checked={form.clearServerPassword} /> Remove the saved server password</label>
          {/if}
          <label>Username <span class="opt">(defaults to the nick)</span> <input bind:value={form.ident} autocomplete="off" spellcheck="false" /></label>
          <label>Real name <span class="opt">(defaults to the nick)</span> <input bind:value={form.realname} autocomplete="off" /></label>
        {/if}

        {#if !privateAllowed}
          <p class="dim">Servers on private networks, and ports below 1024, are not allowed here.</p>
        {/if}
        <div class="row">
          <button class="btn primary" type="submit" disabled={busy}>{form.editing ? 'Save' : 'Add'}</button>
          <button class="btn" type="button" onclick={() => ((form = null), (error = ''))}>Cancel</button>
        </div>
      </form>
    {:else}
      <div class="row">
        <button class="btn primary" disabled={networks.length >= max} onclick={add}>Add a network…</button>
        {#if networks.length >= max}<span class="dim">An account can have {max} networks.</span>{/if}
      </div>
    {/if}
  {/if}
  {#if error}<p class="error" role="alert" data-testid="network-error">{error}</p>{/if}
</div>

<style>
  .networks {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dim,
  .opt {
    color: var(--fg-dim);
    font-size: 0.9em;
    margin: 0;
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
    gap: 4px;
  }
  .head,
  .row,
  .two {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .two {
    align-items: flex-end;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .port {
    width: 6em;
  }
  .badge {
    font-size: 0.8em;
    border-radius: 8px;
    padding: 0 8px;
    border: 1px solid var(--border);
  }
  .badge.connected {
    border-color: var(--ok);
    color: var(--ok);
  }
  .badge.connecting {
    border-color: var(--warn);
    color: var(--warn);
  }
  .form {
    display: grid;
    gap: 8px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 8px;
  }
  .form label {
    display: grid;
    gap: 2px;
  }
  .form label.check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .form input:not([type='checkbox']),
  .form select {
    width: 100%;
    box-sizing: border-box;
  }
  .link {
    justify-self: start;
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
  }
  .confirm {
    border-top: 1px solid var(--border);
    padding-top: 4px;
  }
  .danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
</style>
