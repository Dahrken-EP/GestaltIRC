<script lang="ts">
  import { onMount } from 'svelte'
  import { api, ApiError } from '../lib/api'
  import { app } from '../lib/app.svelte'
  import { blankForm, checkForm, formFromNetwork, parseChannels, toRequest, type NetworkForm } from '../lib/networkform'
  import { settings } from '../lib/settings.svelte'

  const editing = app.serverDialog?.edit ?? null

  let form = $state<NetworkForm | null>(editing ? null : blankForm(app.user))
  let highlights = $state(editing ? settings.networkKeywords[editing]?.join(' ') ?? '' : '')
  let notify = $state(editing ? !settings.networkMuted[editing] : true)
  let privateAllowed = $state(false)
  let error = $state('')
  let busy = $state(false)
  let nameInput: HTMLInputElement | undefined = $state()
  let hostInput: HTMLInputElement | undefined = $state()

  onMount(async () => {
    try {
      const r = await api.listNetworks()
      privateAllowed = r.private_allowed
      if (editing) {
        const detail = r.networks.find((n) => n.name === editing)
        if (detail) form = formFromNetwork(detail)
        else error = 'That server no longer exists.'
      } else if (r.networks.length >= r.max) {
        error = `An account can have ${r.max} servers.`
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load the server.'
    }
  })

  $effect(() => {
    if (form) (form.editing ? hostInput : nameInput)?.focus()
  })

  const close = () => (app.serverDialog = null)

  async function save() {
    if (!form || busy) return
    const problem = checkForm(form)
    if (problem) {
      error = problem
      return
    }
    const f = form
    busy = true
    error = ''
    try {
      const req = toRequest(f)
      if (f.editing) await api.updateNetwork(f.editing, req)
      else await api.addNetwork(req)
      const name = f.editing || f.name.trim()
      // What belongs to this server on the account, not on the connection.
      settings.setNetworkKeywords(name, parseChannels(highlights))
      settings.setNetworkMuted(name, !notify)
      await app.resync()
      if (!f.editing) app.showServer(name)
      close()
    } catch (e) {
      error = e instanceof ApiError || e instanceof Error ? e.message : 'That did not work.'
    } finally {
      busy = false
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="server-title" data-testid="server-dialog">
    <header>
      <h2 id="server-title">{editing ? `Edit ${editing}` : 'Add a server'}</h2>
      <button class="x" onclick={close} aria-label="Close">×</button>
    </header>

    {#if form}
      <form onsubmit={(e) => (e.preventDefault(), void save())}>
        <section>
          <h3>Server</h3>
          {#if !form.editing}
            <label>Name <input bind:this={nameInput} bind:value={form.name} placeholder="libera" autocomplete="off" spellcheck="false" /></label>
          {/if}
          <div class="two">
            <label class="grow">Address <input bind:this={hostInput} bind:value={form.host} placeholder="irc.libera.chat" autocomplete="off" spellcheck="false" /></label>
            <label class="port">Port <input bind:value={form.port} inputmode="numeric" autocomplete="off" /></label>
          </div>
          <label class="check"><input type="checkbox" bind:checked={form.tls} /> Use TLS (encrypted)</label>
          {#if form.tls}
            <label class="check">
              <input type="checkbox" bind:checked={form.tlsInsecure} />
              Accept an untrusted certificate <span class="opt">(self-signed, or from a private authority)</span>
            </label>
            {#if form.tlsInsecure}
              <p class="warn" data-testid="untrusted-warning">
                Only for a server you run or trust. The first time, nothing can tell the real server from an impostor. The
                bouncer then remembers the certificate it saw and refuses a different one.
              </p>
              {#if form.tlsFingerprint}
                <p class="dim" data-testid="remembered-certificate">Remembered certificate (SHA-256): <code>{form.tlsFingerprint}</code></p>
                <label class="check"><input type="checkbox" bind:checked={form.forgetTlsPin} /> Forget it and remember the next one (after the server's certificate was replaced on purpose)</label>
              {/if}
            {/if}
          {/if}
          <label>
            Server password <span class="opt">(only if the server asks for one)</span>
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
        </section>

        <section>
          <h3>Who you are</h3>
          <label>Nick <input bind:value={form.nick} autocomplete="off" spellcheck="false" /></label>
          <label>
            Alternative nicks <span class="opt">(tried in order if the nick is taken; up to five, separated by spaces)</span>
            <input bind:value={form.altNicks} placeholder="matt_ matt__" autocomplete="off" spellcheck="false" />
          </label>
          <div class="two">
            <label class="grow">Username <span class="opt">(defaults to the nick)</span> <input bind:value={form.ident} autocomplete="off" spellcheck="false" /></label>
            <label class="grow">Real name <span class="opt">(defaults to the nick)</span> <input bind:value={form.realname} autocomplete="off" /></label>
          </div>
        </section>

        <section>
          <h3>Logging in</h3>
          {#if form.certificate}
            <p class="dim">This server logs in with a certificate, which is managed with the command line.</p>
          {:else}
            <label>
              SASL
              <select bind:value={form.sasl}>
                <option value="">None</option>
                <option value="PLAIN">Account and password (PLAIN)</option>
                <option value="SCRAM-SHA-256">Account and password (SCRAM-SHA-256)</option>
              </select>
            </label>
            {#if form.sasl}
              <div class="two">
                <label class="grow">Account <input bind:value={form.saslUser} autocomplete="off" spellcheck="false" /></label>
                <label class="grow">
                  Password
                  <input
                    type="password"
                    bind:value={form.saslPassword}
                    placeholder={form.hasSaslPassword ? 'Saved. Leave blank to keep it.' : ''}
                    autocomplete="new-password"
                  />
                </label>
              </div>
            {:else}
              <label>
                NickServ password <span class="opt">(for servers without SASL; sent as IDENTIFY after connecting)</span>
                <input
                  type="password"
                  bind:value={form.nickservPassword}
                  placeholder={form.hasNickservPassword && !form.clearNickservPassword ? 'Saved. Leave blank to keep it.' : ''}
                  autocomplete="new-password"
                />
              </label>
              {#if form.hasNickservPassword}
                <label class="check"><input type="checkbox" bind:checked={form.clearNickservPassword} /> Remove the saved NickServ password</label>
              {/if}
            {/if}
          {/if}
        </section>

        <section>
          <h3>After connecting</h3>
          <label>
            Channels to join <span class="opt">(separated by spaces)</span>
            <input bind:value={form.channels} placeholder="#general #help" autocomplete="off" spellcheck="false" />
          </label>
          <label>
            Commands to run <span class="opt">(one per line, before the channels are joined; do not put passwords here)</span>
            <textarea rows="3" bind:value={form.perform} placeholder="MODE matt +i&#10;msg ChanServ op #general matt" spellcheck="false"></textarea>
          </label>
        </section>

        <section>
          <h3>For this server</h3>
          <label>
            Highlight words <span class="opt">(in addition to your nick and your general words; separated by spaces)</span>
            <input bind:value={highlights} autocomplete="off" spellcheck="false" />
          </label>
          <label class="check"><input type="checkbox" bind:checked={notify} /> Desktop notifications for mentions and private messages here</label>
          <p class="dim">These are saved on your account, not in this browser. Your general notification settings are in Settings.</p>
        </section>

        {#if !privateAllowed}
          <p class="dim">Servers on private networks, and ports below 1024, are not allowed here.</p>
        {/if}
        {#if error}<p class="error" role="alert" data-testid="server-error">{error}</p>{/if}
        <footer>
          <button class="btn" type="button" onclick={close}>Cancel</button>
          <button class="btn primary" type="submit" disabled={busy}>{form.editing ? 'Save' : 'Add server'}</button>
        </footer>
      </form>
    {:else if error}
      <p class="error" role="alert" data-testid="server-error">{error}</p>
      <footer><button class="btn" onclick={close}>Close</button></footer>
    {:else}
      <p class="dim">Loading…</p>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.45);
  }
  .card {
    width: min(560px, calc(100% - 24px));
    max-height: calc(100% - 32px);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: 1.1em;
  }
  .x {
    background: none;
    border: 0;
    color: var(--fg-dim);
    font-size: 1.4em;
    cursor: pointer;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 16px 0;
    overflow-y: auto;
    min-height: 0;
  }
  section {
    display: grid;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 0.75em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-dim);
  }
  label {
    display: grid;
    gap: 2px;
  }
  label.check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  input:not([type='checkbox']),
  select,
  textarea {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
  }
  .two {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .port {
    width: 6em;
  }
  .opt,
  .dim {
    color: var(--fg-dim);
    font-size: 0.9em;
    margin: 0;
  }
  .warn {
    margin: 0;
    padding: 6px 8px;
    border-left: 3px solid var(--warn);
    background: var(--bg);
    font-size: 0.9em;
  }
  code {
    word-break: break-all;
    font-size: 0.85em;
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
  footer {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 0;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
  .card > footer {
    padding: 12px 16px;
  }
</style>
