<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { t } from '../lib/i18n.svelte'

  let user = $state('')
  let password = $state('')
  let userEl: HTMLInputElement

  $effect(() => userEl?.focus())

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const pw = password
    password = ''
    void app.login(user, pw)
  }
</script>

<div class="backdrop">
  <form class="card" onsubmit={submit} aria-labelledby="login-title">
    <div class="brand"><img src="/mark.png" alt="" width="40" height="40" /><span>Gestalt</span></div>
    <h2 id="login-title">{t('login.title')}</h2>
    <p class="hint">{t('login.hint')}</p>

    <label>
      {t('login.user')}
      <input bind:this={userEl} bind:value={user} autocomplete="username" autocapitalize="off" spellcheck="false" required />
    </label>
    <label>
      {t('login.password')}
      <input type="password" bind:value={password} autocomplete="current-password" required />
    </label>

    {#if app.loginError}<p class="error" role="alert">{app.loginError}</p>{/if}

    <div class="actions">
      <button class="btn primary" type="submit" disabled={app.loginBusy}>{app.loginBusy ? t('login.busy') : t('login.title')}</button>
    </div>
  </form>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--bg);
    padding: 16px;
    z-index: 20;
  }
  .card {
    width: min(380px, 100%);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    font-size: 0.85em;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h2 {
    margin: 0;
    font-size: 1.2em;
  }
  .hint {
    margin: 0;
    color: var(--fg-dim);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-weight: 600;
  }
  input {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-weight: 400;
  }
  .error {
    margin: 0;
    color: var(--danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
