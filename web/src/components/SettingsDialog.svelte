<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '../lib/app.svelte'
  import { install } from '../lib/install.svelte'
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

  // Links may have been made, or ended, from another browser since the last look.
  onMount(() => void app.loadGuests())

  let guestBusy = $state(false)
  let guestError = $state('')
  async function toggleGuests(on: boolean) {
    guestBusy = true
    guestError = ''
    try {
      await app.setGuests(on)
    } catch (e) {
      guestError = e instanceof Error ? e.message : 'That did not work.'
    } finally {
      guestBusy = false
    }
  }

  const overrides = $derived(Object.entries(settings.nickColors))

  type Tab = 'general' | 'appearance' | 'notifications' | 'highlights' | 'media' | 'plugins'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'highlights', label: 'Highlights' },
    { id: 'media', label: 'Media' },
    { id: 'plugins', label: 'Plugins' },
  ]
  let tab = $state<Tab>('general')

  /** Servers that have words of their own, so the Highlights tab can say where they are. */
  const perServer = $derived(Object.entries(settings.networkKeywords).filter(([, w]) => w.length))

  function tabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab)
    if (e.key === 'ArrowRight') tab = TABS[(i + 1) % TABS.length]!.id
    else if (e.key === 'ArrowLeft') tab = TABS[(i + TABS.length - 1) % TABS.length]!.id
    else return
    e.preventDefault()
  }

</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings">
    <header>
      <h2 id="settings-title">Settings</h2>
      <button class="x" onclick={close} aria-label="Close settings">×</button>
    </header>

    <div class="tabs" role="tablist" aria-label="Settings sections" tabindex="-1" onkeydown={tabKey}>
      {#each TABS as t (t.id)}
        <button role="tab" id="tab-{t.id}" aria-selected={tab === t.id} aria-controls="panel-{t.id}" tabindex={tab === t.id ? 0 : -1} class:on={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
      {/each}
    </div>

    <div class="panel" role="tabpanel" id="panel-{tab}" aria-labelledby="tab-{tab}">
      {#if tab === 'general'}
        <h3>Behaviour</h3>
        <label class="check"><input type="checkbox" bind:checked={settings.timestamps} onchange={() => settings.save()} /> Show timestamps</label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.sendTyping} onchange={() => settings.save()} />
          Tell others when I am typing
        </label>

        <h3>App</h3>
        {#if install.kind === 'prompt'}
          <div class="row">
            <span class="grow">Install Gestalt as an app, with its own window and icon.</span>
            <button class="btn" data-testid="install-app" onclick={() => void install.install()}>Install</button>
          </div>
        {:else if install.kind === 'installed'}
          <p class="note">Gestalt is running as an installed app.</p>
        {:else if install.kind === 'ios'}
          <p class="note" data-testid="install-ios">To install Gestalt, tap the Share button in Safari and choose <strong>Add to Home Screen</strong>.</p>
        {:else}
          <p class="note" data-testid="install-none">
            To install Gestalt as an app, use your browser's menu (look for <strong>Install</strong> or <strong>Add to Home screen</strong>).
            Browsers only offer it on a page served over HTTPS.
          </p>
        {/if}

        {#if app.guests.available}
          <h3>Guests</h3>
          <label class="check">
            <input
              type="checkbox"
              data-testid="guests-toggle"
              checked={app.guests.enabled}
              disabled={guestBusy}
              onchange={(e) => void toggleGuests((e.currentTarget as HTMLInputElement).checked)}
            />
            Let people without Gestalt reach me through a one-time link
          </label>
          {#if app.guests.enabled}
            <label class="check">
              <input type="checkbox" bind:checked={settings.announceVoice} onchange={() => settings.save()} />
              Say in a channel, with a link, when I join its voice chat
            </label>
          {/if}
          <p class="note">
            Joining a voice chat makes a link, and says so in the channel, so anyone can join from a browser. A direct chat or call
            that nobody's client answers sends the other person a one-time link. They enter a name and talk to you from their browser.
            Turn this off and every open link stops working.
          </p>
          {#if guestError}<p class="note error" role="alert">{guestError}</p>{/if}
          {#if app.guests.enabled && app.guestInvites.length}
            <ul class="links" data-testid="guest-links">
              {#each app.guestInvites as inv (inv.id)}
                <li>
                  <span class="grow">{inv.kind === 'room' ? `Voice room ${inv.target}` : `Direct chat for ${inv.target}`} <span class="dim">on {inv.network}</span></span>
                  <button class="btn" onclick={() => void app.revokeGuestInvite(inv.id)}>End link</button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}

        <h3>Servers</h3>
        <p class="note">
          Add a server with the <strong>+</strong> in the bar on the left. Click the server you are on to edit, switch off or remove it.
        </p>
        <div class="row">
          <button class="btn" onclick={() => ((app.showSettings = false), app.openServerDialog())}>Add a server…</button>
        </div>

        <h3>Account</h3>
        <div class="row">
          <span class="grow">Logged in as <strong>{app.user}</strong></span>
          <button class="btn" onclick={() => app.logout()}>Log out</button>
        </div>
        <p class="note">
          Your settings, highlight words and servers are kept on the bouncer, so they follow you to other browsers. Permission
          for desktop notifications belongs to each browser, so that one switch stays with it.
        </p>
      {:else if tab === 'appearance'}
        <h3>Theme</h3>
        <div class="grid">
          <label>
            Mode
            <select bind:value={settings.theme} onchange={() => settings.save()}>
              {#each ['system', 'light', 'dark'] as t (t)}<option value={t as Theme}>{t === 'system' ? 'system (follow the device)' : t}</option>{/each}
            </select>
          </label>
          <label>
            Density
            <select bind:value={settings.density} onchange={() => settings.save()}>
              {#each ['compact', 'comfortable'] as d (d)}<option value={d as Density}>{d}</option>{/each}
            </select>
          </label>
        </div>

        <h3>Nick colours</h3>
        <p class="note">Colours are automatic for each nick. Choose a colour to use instead for one.</p>
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
      {:else if tab === 'notifications'}
        <h3>On this browser</h3>
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
        <p class="note">To silence one server, open its menu (click the server in the left bar), choose Edit, and untick its notifications.</p>
      {:else if tab === 'highlights'}
        <h3>Words that highlight a line</h3>
        <label>
          On every server <span class="opt">(your nick always highlights; one per line)</span>
          <textarea rows="4" bind:value={keywordText} onblur={saveKeywords}></textarea>
        </label>
        <h3>For one server</h3>
        {#if perServer.length}
          <ul>
            {#each perServer as [name, words] (name)}
              <li>
                <span class="grow"><strong>{name}</strong> <span class="opt">{words.join(', ')}</span></span>
                <button class="btn" onclick={() => ((app.showSettings = false), app.openServerDialog(name))}>Edit</button>
              </li>
            {/each}
          </ul>
        {/if}
        <p class="note">Words for one server are set in that server's dialog, under its name in the left bar.</p>
      {:else if tab === 'media'}
        <h3>Links in chat</h3>
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
        <label class="check">
          <input type="checkbox" bind:checked={settings.imgurDirect} onchange={() => settings.save()} />
          Load imgur pictures from imgur itself, in this browser
        </label>
        <p class="note">
          Imgur turns away the addresses of many servers. If the bouncer's is one of them (a picture says imgur answered 429 or 403),
          this makes your browser fetch imgur pictures instead. Imgur then sees your address, and nothing else is sent.
        </p>
        <p class="note">
          The bouncer fetches everything else for you, so those sites never see your address. A player loads from YouTube or
          Streamable only when you press play.
        </p>
      {:else if tab === 'plugins'}
        <PluginsPanel />
      {/if}
    </div>
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
    width: min(620px, 100%);
    height: min(640px, 100%);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 20px 6px;
  }
  h2 {
    margin: 0;
    font-size: 1.2em;
  }
  h3 {
    margin: 8px 0 0;
    font-size: 0.75em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-dim);
  }
  h3:first-child {
    margin-top: 0;
  }
  .x {
    font-size: 1.3em;
    padding: 0 6px;
    color: var(--fg-dim);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .tabs button {
    padding: 8px 12px;
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fg-dim);
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .tabs button:hover {
    color: var(--fg);
  }
  .tabs button.on {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .panel {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
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
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .links li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .note.error {
    color: var(--danger);
  }
  .note {
    margin: 0;
    color: var(--fg-dim);
    font-size: 0.9em;
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
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
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
