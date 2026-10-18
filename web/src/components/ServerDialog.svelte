<script lang="ts">
  import { onMount } from 'svelte'
  import { api, ApiError } from '../lib/api'
  import { app } from '../lib/app.svelte'
  import { blankForm, checkForm, formFromNetwork, parseChannels, portForTls, toRequest, type NetworkForm } from '../lib/networkform'
  import { settings } from '../lib/settings.svelte'
  import { t } from '../lib/i18n.svelte'

  const editing = app.serverDialog?.edit ?? null
  // Validation messages come from the form helper in the catalogue's language; the
  // helper itself stays key-producing, so map its English text to catalogue keys.
  const ERR_KEYS = [
    'serverdlg.err_name', 'serverdlg.err_host', 'serverdlg.err_host_spaces', 'serverdlg.err_port',
    'serverdlg.err_tls', 'serverdlg.err_nick', 'serverdlg.err_nick_spaces', 'serverdlg.err_altnicks',
    'serverdlg.err_ident', 'serverdlg.err_sasl_user', 'serverdlg.err_sasl_pass',
    'serverdlg.err_perform_count', 'serverdlg.err_perform_words',
  ]
  const REAL_ERRORS = [
    'Give the network a short name: letters, digits, "-" or "_".',
    'Enter the server address.',
    'The server address cannot contain spaces.',
    'The port must be a number from 1 to 65535.',
    'Accepting an untrusted certificate needs TLS.',
    'Enter the nick to use.',
    'A nick cannot contain spaces.',
    'Give at most five alternative nicks.',
    'The username cannot contain spaces.',
    'Enter the account name for SASL.',
    'Enter the SASL password.',
    'Give at most ten commands to run on connect.',
    'PASS, USER, CAP, AUTHENTICATE and QUIT cannot be used in the commands to run on connect.',
  ]
  const localizeError = (msg: string) => {
    const i = REAL_ERRORS.indexOf(msg)
    return i >= 0 ? t(ERR_KEYS[i]!) : msg
  }

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
        else error = t('serverdlg.gone')
      } else if (r.networks.length >= r.max) {
        error = t('serverdlg.max_servers', { max: r.max })
      }
    } catch (e) {
      error = e instanceof Error ? e.message : t('serverdlg.load_fail')
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
      error = localizeError(problem)
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
      error = e instanceof ApiError || e instanceof Error ? e.message : t('server.error')
    } finally {
      busy = false
    }
  }
</script>

<!-- The dialog closes with its × or Cancel, and only those: a click outside it, or Escape, would throw away a half-filled form. -->
<div class="backdrop">
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="server-title" data-testid="server-dialog">
    <header>
      <h2 id="server-title">{editing ? t('serverdlg.edit_title', { name: editing }) : t('serverdlg.add_title')}</h2>
      <button class="x" onclick={close} aria-label={t('button.close')}>×</button>
    </header>

    {#if form}
      <form onsubmit={(e) => (e.preventDefault(), void save())}>
        <section>
          <h3>{t('serverdlg.sect_server')}</h3>
          {#if !form.editing}
            <label>{t('serverdlg.name')} <input bind:this={nameInput} bind:value={form.name} placeholder="libera" autocomplete="off" spellcheck="false" /></label>
          {/if}
          <div class="two">
            <label class="grow">{t('serverdlg.address')} <input bind:this={hostInput} bind:value={form.host} placeholder="irc.libera.chat" autocomplete="off" spellcheck="false" /></label>
            <label class="port">{t('serverdlg.port')} <input bind:value={form.port} inputmode="numeric" autocomplete="off" /></label>
          </div>
          <label class="check"><input type="checkbox" bind:checked={form.tls} onchange={() => form && (form.port = portForTls(form.port, form.tls))} /> {t('serverdlg.use_tls')}</label>
          {#if form.tls}
            <label class="check">
              <input type="checkbox" bind:checked={form.tlsInsecure} />
              {t('serverdlg.accept_untrusted')} <span class="opt">{t('serverdlg.untrusted_opt')}</span>
            </label>
            {#if form.tlsInsecure}
              <p class="warn" data-testid="untrusted-warning">{t('serverdlg.untrusted_warn')}</p>
              {#if form.tlsFingerprint}
                <p class="dim" data-testid="remembered-certificate">{t('serverdlg.remembered_cert')} <code>{form.tlsFingerprint}</code></p>
                <label class="check"><input type="checkbox" bind:checked={form.forgetTlsPin} /> {t('serverdlg.forget_pin')}</label>
              {/if}
            {/if}
          {/if}
          <label>
            {t('serverdlg.server_password')} <span class="opt">{t('serverdlg.password_opt')}</span>
            <input
              type="password"
              bind:value={form.serverPassword}
              placeholder={form.hasServerPassword && !form.clearServerPassword ? t('serverdlg.saved_keep') : ''}
              autocomplete="new-password"
            />
          </label>
          {#if form.hasServerPassword}
            <label class="check"><input type="checkbox" bind:checked={form.clearServerPassword} /> {t('serverdlg.remove_saved_password')}</label>
          {/if}
        </section>

        <section>
          <h3>{t('serverdlg.sect_who')}</h3>
          <label>{t('serverdlg.nick')} <input bind:value={form.nick} autocomplete="off" spellcheck="false" /></label>
          <label>
            {t('serverdlg.alt_nicks')} <span class="opt">{t('serverdlg.alt_nicks_opt')}</span>
            <input bind:value={form.altNicks} placeholder="matt_ matt__" autocomplete="off" spellcheck="false" />
          </label>
          <div class="two">
            <label class="grow">{t('serverdlg.username')} <span class="opt">{t('serverdlg.defaults_nick')}</span> <input bind:value={form.ident} autocomplete="off" spellcheck="false" /></label>
            <label class="grow">{t('serverdlg.realname')} <span class="opt">{t('serverdlg.defaults_nick')}</span> <input bind:value={form.realname} autocomplete="off" /></label>
          </div>
        </section>

        <section>
          <h3>{t('serverdlg.sect_login')}</h3>
          {#if form.certificate}
            <p class="dim">{t('serverdlg.cert_note')}</p>
          {:else}
            <label>
              SASL
              <select bind:value={form.sasl}>
                <option value="">{t('serverdlg.sasl_none')}</option>
                <option value="PLAIN">{t('serverdlg.sasl_plain')}</option>
                <option value="SCRAM-SHA-256">{t('serverdlg.sasl_scram')}</option>
              </select>
            </label>
            {#if form.sasl}
              <div class="two">
                <label class="grow">{t('serverdlg.account')} <input bind:value={form.saslUser} autocomplete="off" spellcheck="false" /></label>
                <label class="grow">
                  {t('login.password')}
                  <input
                    type="password"
                    bind:value={form.saslPassword}
                    placeholder={form.hasSaslPassword ? t('serverdlg.saved_keep') : ''}
                    autocomplete="new-password"
                  />
                </label>
              </div>
            {:else}
              <label>
                {t('serverdlg.nickserv_password')} <span class="opt">{t('serverdlg.nickserv_opt')}</span>
                <input
                  type="password"
                  bind:value={form.nickservPassword}
                  placeholder={form.hasNickservPassword && !form.clearNickservPassword ? t('serverdlg.saved_keep') : ''}
                  autocomplete="new-password"
                />
              </label>
              {#if form.hasNickservPassword}
                <label class="check"><input type="checkbox" bind:checked={form.clearNickservPassword} /> {t('serverdlg.remove_nickserv')}</label>
              {/if}
            {/if}
          {/if}
        </section>

        <section>
          <h3>{t('serverdlg.sect_after')}</h3>
          <label>
            {t('serverdlg.channels_join')} <span class="opt">{t('serverdlg.channels_opt')}</span>
            <input bind:value={form.channels} placeholder="#general #help" autocomplete="off" spellcheck="false" />
          </label>
          <label>
            {t('serverdlg.perform')} <span class="opt">{t('serverdlg.perform_opt')}</span>
            <textarea rows="3" bind:value={form.perform} placeholder="MODE matt +i&#10;msg ChanServ op #general matt" spellcheck="false"></textarea>
          </label>
        </section>

        <section>
          <h3>{t('serverdlg.sect_this_server')}</h3>
          <label>
            {t('serverdlg.highlight_words')} <span class="opt">{t('serverdlg.highlight_opt')}</span>
            <input bind:value={highlights} autocomplete="off" spellcheck="false" />
          </label>
          <label class="check"><input type="checkbox" bind:checked={notify} /> {t('serverdlg.notify_check')}</label>
          <p class="dim">{t('serverdlg.for_this_note')}</p>
        </section>

        {#if !privateAllowed}
          <p class="dim">{t('serverdlg.private_note')}</p>
        {/if}
        {#if error}<p class="error" role="alert" data-testid="server-error">{error}</p>{/if}
        <footer>
          <button class="btn" type="button" onclick={close}>{t('button.cancel')}</button>
          <button class="btn primary" type="submit" disabled={busy}>{form.editing ? t('button.save') : t('serverdlg.add_server_btn')}</button>
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
