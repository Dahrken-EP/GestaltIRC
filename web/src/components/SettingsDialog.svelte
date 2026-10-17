<script lang="ts">
  import { app } from '../lib/app.svelte'
  import NetworksPanel from './NetworksPanel.svelte'
  import PluginsPanel from './PluginsPanel.svelte'
  import { notificationsSupported, requestNotifyPermission } from '../lib/notify'
  import { disablePush, enablePush, pushSubscribed, pushSupported } from '../lib/push'
  import { settings, type Density, type Theme } from '../lib/settings.svelte'

  let keywordText = $state(settings.keywords.join('\n'))
  let colorNick = $state('')
  let colorValue = $state('#c0392b')
  let notifyMsg = $state('')
  let pushOn = $state(false)
  let pushMsg = $state('')
  let pushBusy = $state(false)

  $effect(() => {
    void pushSubscribed().then((on) => (pushOn = on))
  })

  async function togglePush(e: Event) {
    const want = (e.currentTarget as HTMLInputElement).checked
    pushBusy = true
    pushMsg = ''
    try {
      if (want) {
        const result = await enablePush()
        pushOn = result === 'ok'
        if (result === 'denied') pushMsg = 'The browser did not allow notifications. Check the site permissions.'
        else if (result === 'unsupported') pushMsg = 'This browser cannot receive background notifications.'
        else if (result === 'error') pushMsg = 'Could not set up background notifications. Is the page served over HTTPS?'
      } else {
        await disablePush()
        pushOn = false
      }
    } finally {
      pushBusy = false
    }
  }

  function close() {
    app.showSettings = false
  }

  function saveKeywords() {
    settings.keywords = keywordText
      .split(/[\n,]/)
      .map((k) => k.trim())
      .filter(Boolean)
    settings.save()
  }

  async function toggleNotify(e: Event) {
    const on = (e.currentTarget as HTMLInputElement).checked
    if (on) {
      const ok = await requestNotifyPermission()
      settings.notify = ok
      notifyMsg = ok ? '' : 'The browser did not allow notifications. Check the site permissions.'
    } else {
      settings.notify = false
      notifyMsg = ''
    }
    settings.save()
  }

  const overrides = $derived(Object.entries(settings.nickColors))
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header>
      <h2 id="settings-title">Settings</h2>
      <button class="x" onclick={close} aria-label="Close settings">×</button>
    </header>

    <div class="grid">
      <label>
        Theme
        <select bind:value={settings.theme} onchange={() => settings.save()}>
          {#each ['system', 'light', 'dark'] as t (t)}<option value={t as Theme}>{t}</option>{/each}
        </select>
      </label>
      <label>
        Density
        <select bind:value={settings.density} onchange={() => settings.save()}>
          {#each ['compact', 'comfortable'] as d (d)}<option value={d as Density}>{d}</option>{/each}
        </select>
      </label>
    </div>

    <label class="check"><input type="checkbox" bind:checked={settings.timestamps} onchange={() => settings.save()} /> Show timestamps</label>

    <label class="check">
      <input type="checkbox" bind:checked={settings.sendTyping} onchange={() => settings.save()} />
      Tell others when I am typing
    </label>

    <fieldset>
      <legend>Links</legend>
      <label class="check">
        <input type="checkbox" bind:checked={settings.inlineMedia} onchange={() => settings.save()} />
        Show pictures, video and sound inline
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={settings.previews} onchange={() => settings.save()} />
        Show a title and picture for other links
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={settings.embeds} onchange={() => settings.save()} />
        Offer YouTube and Streamable players
      </label>
      <p class="note">
        The bouncer fetches these for you, so the other sites never see your address. A player loads from YouTube or
        Streamable only when you press play.
      </p>
    </fieldset>

    <label class="check">
      <input type="checkbox" checked={settings.notify} onchange={toggleNotify} disabled={!notificationsSupported()} />
      Desktop notifications for mentions and private messages
    </label>
    {#if notifyMsg}<p class="note">{notifyMsg}</p>{/if}

    <label class="check">
      <input type="checkbox" checked={pushOn} onchange={togglePush} disabled={!pushSupported() || pushBusy} />
      Background notifications, even when this tab is closed
    </label>
    {#if pushMsg}<p class="note">{pushMsg}</p>{/if}
    <p class="note">
      The first option shows alerts while this page is open. The second asks the bouncer to send them to this browser when no
      client is connected. It needs HTTPS, and each browser opts in separately.
    </p>

    <label>
      Highlight words <span class="opt">(your nick always highlights; one per line)</span>
      <textarea rows="3" bind:value={keywordText} onblur={saveKeywords}></textarea>
    </label>

    <fieldset>
      <legend>Networks</legend>
      <NetworksPanel />
    </fieldset>

    <fieldset>
      <legend>Plugins</legend>
      <PluginsPanel />
    </fieldset>

    <fieldset>
      <legend>Account</legend>
      <div class="row">
        <span class="grow">Logged in as <strong>{app.user}</strong></span>
        <button class="btn" onclick={() => app.logout()}>Log out</button>
      </div>
    </fieldset>

    <fieldset>
      <legend>Nick colours</legend>
      <div class="row">
        <input placeholder="nick" bind:value={colorNick} aria-label="Nick" />
        <input type="color" bind:value={colorValue} aria-label="Colour" />
        <button
          class="btn"
          onclick={() => {
            if (colorNick.trim()) settings.setNickColor(colorNick.trim(), colorValue)
            colorNick = ''
          }}>Set</button
        >
      </div>
      {#if overrides.length}
        <ul>
          {#each overrides as [nick, color] (nick)}
            <li>
              <span class="swatch" style:background={color}></span>{nick}
              <button class="x" aria-label="Reset colour for {nick}" onclick={() => settings.setNickColor(nick, null)}>×</button>
            </li>
          {/each}
        </ul>
      {/if}
    </fieldset>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.45);
    padding: 16px;
    z-index: 30;
  }
  .card {
    width: min(460px, 100%);
    max-height: 100%;
    overflow-y: auto;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 1.2em;
  }
  .x {
    font-size: 1.3em;
    padding: 0 6px;
    color: var(--fg-dim);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-weight: 600;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    font-weight: 400;
  }
  .opt {
    font-weight: 400;
    color: var(--fg-dim);
  }
  select,
  textarea,
  input:not([type]) {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-weight: 400;
  }
  .note {
    margin: 0;
    color: var(--fg-dim);
    font-size: 0.9em;
  }
  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .row input:not([type]) {
    flex: 1;
    min-width: 0;
  }
  ul {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    display: inline-block;
  }
</style>
