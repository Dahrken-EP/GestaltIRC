<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '../lib/app.svelte'
  import { install } from '../lib/install.svelte'
  import PluginsPanel from './PluginsPanel.svelte'
  import { checkUpdate, installUpdate, type UpdateStatus } from '../lib/update'
  import { notificationsSupported, requestNotifyPermission } from '../lib/notify'
  import { disablePush, enablePush, pushSubscribed, pushSupported } from '../lib/push'
  import { settings, type Density, type Theme } from '../lib/settings.svelte'
  import { allLangs, getLang, langLabel, setLang, type Lang, t } from '../lib/i18n.svelte'

  /** Escape user-controlled text before interpolating into an {@html} translation. */
  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  let keywordText = $state(settings.keywords.join('\n'))
  let colorNick = $state('')
  let colorValue = $state('#c0392b')
  let notifyMsg = $state('')
  let pushOn = $state(false)
  let pushMsg = $state('')
  let pushBusy = $state(false)
  let updateStatus = $state<UpdateStatus>('up-to-date')
  let updateVersion = $state('')
  let updateChecking = $state(false)

  async function checkForUpdate() {
    updateChecking = true
    try {
      const info = await checkUpdate()
      updateStatus = info.status
      updateVersion = info.version ?? ''
    } finally {
      updateChecking = false
    }
  }

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
        if (result === 'denied') pushMsg = t('settings.push_denied')
        else if (result === 'unsupported') pushMsg = t('settings.push_unsupported')
        else if (result === 'error') pushMsg = t('settings.push_error')
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
      notifyMsg = ok ? '' : t('settings.check_failed', { error: 'notify' })
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
      guestError = e instanceof Error ? e.message : t('settings.check_failed', { error: 'guests' })
    } finally {
      guestBusy = false
    }
  }

  const overrides = $derived(Object.entries(settings.nickColors))

  type Tab = 'general' | 'appearance' | 'notifications' | 'highlights' | 'media' | 'plugins' | 'about'
  const TABS: { id: Tab }[] = [
    { id: 'general' },
    { id: 'appearance' },
    { id: 'notifications' },
    { id: 'highlights' },
    { id: 'media' },
    { id: 'plugins' },
    { id: 'about' },
  ]
  let tab = $state<Tab>('general')

  let { lang, onlangchange }: { lang: Lang; onlangchange: (l: Lang) => void } = $props()

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
      <h2 id="settings-title">{t('settings.title')}</h2>
      <button class="x" onclick={close} aria-label={t('settings.close')}>×</button>
    </header>

    <div class="tabs" role="tablist" aria-label={t('settings.sections')} tabindex="-1" onkeydown={tabKey}>
      {#each TABS as tb (tb.id)}
        <button role="tab" id="tab-{tb.id}" aria-selected={tab === tb.id} aria-controls="panel-{tb.id}" tabindex={tab === tb.id ? 0 : -1} class:on={tab === tb.id} onclick={() => (tab = tb.id)}>{t('settings.' + tb.id)}</button>
      {/each}
    </div>

    <div class="panel" role="tabpanel" id="panel-{tab}" aria-labelledby="tab-{tab}">
      {#if tab === 'general'}
        <h3>{t('settings.behaviour')}</h3>
        <label class="check"><input type="checkbox" bind:checked={settings.timestamps} onchange={() => settings.save()} /> {t('settings.show_timestamps')}</label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.sendTyping} onchange={() => settings.save()} />
          {t('settings.send_typing')}
        </label>

        <h3>{t('settings.app')}</h3>
        {#if install.kind === 'prompt'}
          <div class="row">
            <span class="grow">{t('settings.install_app')}</span>
            <button class="btn" data-testid="install-app" onclick={() => void install.install()}>{t('button.install')}</button>
          </div>
        {:else if install.kind === 'installed'}
          <p class="note">{t('settings.installed_app')}</p>
        {:else if install.kind === 'ios'}
          <p class="note" data-testid="install-ios">{@html t('settings.install_ios')}</p>
        {:else}
          <p class="note" data-testid="install-none">
            {@html t('settings.install_browser')}
          </p>
        {/if}

        {#if app.guests.available}
          <h3>{t('settings.guests')}</h3>
          <label class="check">
            <input
              type="checkbox"
              data-testid="guests-toggle"
              checked={app.guests.enabled}
              disabled={guestBusy}
              onchange={(e) => void toggleGuests((e.currentTarget as HTMLInputElement).checked)}
            />
            {t('settings.let_guests')}
          </label>
          {#if app.guests.enabled}
            <label class="check">
              <input type="checkbox" bind:checked={settings.announceVoice} onchange={() => settings.save()} />
              {t('settings.announce_voice')}
            </label>
          {/if}
          <p class="note">
            {t('settings.guests_desc')}
          </p>
          {#if guestError}<p class="note error" role="alert">{guestError}</p>{/if}
          {#if app.guests.enabled && app.guestInvites.length}
            <ul class="links" data-testid="guest-links">
              {#each app.guestInvites as inv (inv.id)}
                <li>
                  <span class="grow">{inv.kind === 'room' ? t('settings.voice_room', { target: inv.target }) : t('settings.direct_chat', { target: inv.target })} <span class="dim">{t('settings.on', { network: inv.network })}</span></span>
                  <button class="btn" onclick={() => void app.revokeGuestInvite(inv.id)}>{t('button.end_link')}</button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}

        <h3>{t('settings.servers')}</h3>
        <p class="note">{t('settings.servers_desc')}</p>
        <div class="row">
          <button class="btn" onclick={() => ((app.showSettings = false), app.openServerDialog())}>{t('button.add_server')}</button>
        </div>

        <h3>{t('settings.account')}</h3>
        <div class="row">
          <span class="grow">{@html t('settings.logged_in', { user: esc(app.user) })}</span>
          <button class="btn" onclick={() => app.logout()}>{t('button.logout')}</button>
        </div>
        <p class="note">
          {t('settings.settings_follow')}
        </p>
      {:else if tab === 'appearance'}
        <h3>{t('settings.theme')}</h3>
        <div class="grid">
          <label>
            {t('settings.mode')}
            <select bind:value={settings.theme} onchange={() => settings.save()}>
              {#each ['system', 'light', 'dark'] as theme (theme)}<option value={theme as Theme}>{theme === 'system' ? t('settings.system') : theme}</option>{/each}
            </select>
          </label>
          <label>
            {t('settings.density')}
            <select bind:value={settings.density} onchange={() => settings.save()}>
              {#each ['compact', 'comfortable'] as d (d)}<option value={d as Density}>{d}</option>{/each}
            </select>
          </label>
          <label>
            {t('settings.language')}
            <select bind:value={lang} onchange={(e) => {
              const l = (e.currentTarget as HTMLSelectElement).value as Lang
              setLang(l)
              onlangchange(l)
              settings.save()
            }}>
              {#each allLangs as l (l)}<option value={l}>{langLabel(l)}</option>{/each}
            </select>
          </label>
        </div>

        <h3>{t('settings.display')}</h3>
        <label class="check">
          <input type="checkbox" checked={settings.contrast === 'high'} onchange={(e) => {
            settings.contrast = (e.currentTarget as HTMLInputElement).checked ? 'high' : 'default'
            settings.save()
          }} />
          {t('settings.high_contrast')}
        </label>
        <h3>{t('settings.nick_colours')}</h3>
        <p class="note">{t('settings.nick_colours_desc')}</p>
        <div class="row">
          <input placeholder={t('settings.nick_placeholder')} bind:value={colorNick} aria-label={t('settings.nick')} />
          <input type="color" bind:value={colorValue} aria-label={t('settings.colour')} />
          <button
            class="btn"
            onclick={() => {
              if (colorNick.trim()) settings.setNickColor(colorNick.trim(), colorValue)
              colorNick = ''
            }}>{t('button.set')}</button
          >
        </div>
        {#if overrides.length}
          <ul>
            {#each overrides as [nick, color] (nick)}
              <li>
                <span class="swatch" style:background={color}></span>{nick}
                <button class="x" aria-label={t('settings.reset_colour', { nick })} onclick={() => settings.setNickColor(nick, null)}>×</button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else if tab === 'notifications'}
        <h3>{t('settings.on_this_browser')}</h3>
        <label class="check">
          <input type="checkbox" checked={settings.notify} onchange={toggleNotify} disabled={!notificationsSupported()} />
          {t('settings.desktop_notifications')}
        </label>
        {#if notifyMsg}<p class="note">{notifyMsg}</p>{/if}
        <label class="check">
          <input type="checkbox" bind:checked={settings.audioAlerts} onchange={() => settings.save()} />
          {t('settings.audio_alerts')}
        </label>
        <label class="check">
          <input type="checkbox" checked={pushOn} onchange={togglePush} disabled={!pushSupported() || pushBusy} />
          {t('settings.background_notifications')}
        </label>
        {#if pushMsg}<p class="note">{pushMsg}</p>{/if}
        <p class="note">
          {t('settings.notifications_desc')}
        </p>
        <p class="note">{t('settings.silence_server')}</p>
      {:else if tab === 'highlights'}
        <h3>{t('settings.highlight_words')}</h3>
        <label>
          {t('settings.every_server')} <span class="opt">{t('settings.nick_highlights')}</span>
          <textarea rows="4" bind:value={keywordText} onblur={saveKeywords}></textarea>
        </label>
        <h3>{t('settings.for_one_server')}</h3>
        {#if perServer.length}
          <ul>
            {#each perServer as [name, words] (name)}
              <li>
                <span class="grow"><strong>{name}</strong> <span class="opt">{words.join(', ')}</span></span>
                <button class="btn" onclick={() => ((app.showSettings = false), app.openServerDialog(name))}>{t('button.edit')}</button>
              </li>
            {/each}
          </ul>
        {/if}
        <p class="note">{t('settings.server_words_desc')}</p>
      {:else if tab === 'media'}
        <h3>{t('settings.links_in_chat')}</h3>
        <label class="check">
          <input type="checkbox" bind:checked={settings.inlineMedia} onchange={() => settings.save()} />
          {t('settings.inline_media')}
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.previews} onchange={() => settings.save()} />
          {t('settings.previews')}
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.embeds} onchange={() => settings.save()} />
          {t('settings.embeds_desc')}
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.threadIndicators} onchange={() => settings.save()} />
          {t('settings.thread_indicators')}
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.presenceIndicators} onchange={() => settings.save()} />
          {t('settings.presence_indicators')}
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.imgurDirect} onchange={() => settings.save()} />
          {t('settings.imgur_direct')}
        </label>
        <p class="note">
          {t('settings.imgur_note')}
        </p>
        <p class="note">
          {t('settings.imgur_note2')}
        </p>
      {:else if tab === 'plugins'}
        <PluginsPanel />
      {:else if tab === 'about'}
        <h3>{t('settings.about_gestalt')}</h3>
        <p class="note">{t('settings.about_desc', { version: __APP_VERSION__ })}</p>
        <h3>{t('settings.keyboard_shortcuts')}</h3>
        <ul class="shortcuts">
          <li><kbd>Ctrl</kbd> + <kbd>K</kbd> — {t('shortcut.quick_switcher')}</li>
          <li><kbd>Ctrl</kbd> + <kbd>F</kbd> — {t('shortcut.search')}</li>
          <li><kbd>Alt</kbd> + <kbd>A</kbd> — {t('shortcut.next_unread')}</li>
          <li><kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd> — {t('shortcut.scroll_history')}</li>
          <li><kbd>Esc</kbd> — {t('shortcut.cancel')}</li>
          <li><kbd>Ctrl</kbd> + <kbd>E</kbd> — {t('shortcut.emoji')}</li>
        </ul>
        <h3>{t('settings.updates')}</h3>
        <div class="row">
          <button class="btn" disabled={updateChecking} onclick={checkForUpdate}>
            {updateChecking ? t('button.checking') : t('button.check_updates')}
          </button>
        </div>
        {#if updateStatus === 'update-available'}
          <div class="row">
            <span class="grow">{t('settings.update_available', { version: updateVersion })}</span>
            <button class="btn primary" onclick={() => void installUpdate()}>{t('button.install_update')}</button>
          </div>
        {:else if updateStatus === 'error'}
          <p class="note error">{t('settings.check_failed', { error: updateVersion })}</p>
        {:else if updateStatus === 'up-to-date'}
          <p class="note">{t('settings.up_to_date')}</p>
        {/if}
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
  .shortcuts {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
  }
  .shortcuts li {
    display: flex;
    gap: 8px;
    font-size: 0.9em;
  }
  kbd {
    display: inline-block;
    min-width: 1.6em;
    text-align: center;
    padding: 1px 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-panel);
    color: var(--fg);
    font-family: inherit;
    font-size: 0.85em;
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
