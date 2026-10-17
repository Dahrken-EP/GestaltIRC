<script lang="ts">
  import { app, defaultUrl } from '../lib/app.svelte'

  let login = $state(app.lastLogin.login)
  let password = $state('')
  let nick = $state(app.lastLogin.nick)
  let url = $state(app.lastLogin.url || defaultUrl())
  let error = $state('')
  let el: HTMLInputElement

  $effect(() => {
    // Show the server's reason when a login attempt just failed.
    if (app.loginError) error = app.loginError
  })
  $effect(() => {
    ;(login ? document.getElementById('password') : el)?.focus()
  })

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const err = app.add(login, password, nick, url)
    if (err) error = err
    else password = ''
  }
</script>

<div class="backdrop">
  <form class="card" onsubmit={submit} aria-labelledby="login-title">
    <h2 id="login-title">Connect to a network</h2>
    <p class="hint">Log in with your bouncer account as <code>user/network</code>.</p>

    <label>
      Login
      <input bind:this={el} bind:value={login} placeholder="matt/libera" autocomplete="username" required />
    </label>
    <label>
      Password
      <input id="password" type="password" bind:value={password} autocomplete="current-password" required />
    </label>
    <label>
      Nick <span class="opt">(optional)</span>
      <input bind:value={nick} placeholder="defaults to your username" />
    </label>

    <details>
      <summary>Server</summary>
      <label>
        WebSocket URL
        <input bind:value={url} spellcheck="false" />
      </label>
    </details>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      {#if app.networks.length}
        <button type="button" class="btn" onclick={() => { app.showLogin = false; app.loginError = '' }}>Cancel</button>
      {/if}
      <button class="btn primary" type="submit">Connect</button>
    </div>
  </form>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    padding: 16px;
    z-index: 20;
  }
  .card {
    width: min(420px, 100%);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
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
  .opt {
    font-weight: 400;
    color: var(--fg-dim);
  }
  input {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-weight: 400;
  }
  summary {
    cursor: pointer;
    color: var(--fg-dim);
    margin-bottom: 8px;
  }
  .error {
    margin: 0;
    color: var(--danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  code {
    font-family: var(--mono);
  }
</style>
