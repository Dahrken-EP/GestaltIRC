<script lang="ts">
  import { plugins } from '../lib/plugins/manager.svelte'
  import type { RegistryPlugin } from '../lib/plugins/registry'
  import { t } from '../lib/i18n.svelte'

  let filter = $state('')
  let installing = $state<string | null>(null)
  let status = $state<{ name: string; ok: boolean; error?: string } | null>(null)

  const categories = ['utility', 'moderation', 'fun', 'info'] as const

  const entries = $derived.by(() => {
    const f = filter.toLowerCase()
    return plugins
      .registryEntries()
      .filter((e) => e.manifest.name.toLowerCase().includes(f) || e.manifest.description.toLowerCase().includes(f))
  })

  async function install(entry: RegistryPlugin & { installed: boolean }) {
    if (entry.installed) return
    installing = entry.manifest.name
    status = null
    try {
      const r = plugins.installFromRegistry(entry.manifest.name)
      if (r.ok) {
        status = { name: entry.manifest.name, ok: true }
      } else {
        status = { name: entry.manifest.name, ok: false, error: r.error }
      }
    } finally {
      installing = null
    }
  }

  const categoryLabel: Record<string, string> = {
    utility: t('registry.cat_utility'),
    moderation: t('registry.cat_moderation'),
    fun: t('registry.cat_fun'),
    info: t('registry.cat_info'),
  }
</script>

<div class="registry">
  <div class="toolbar">
    <input
      type="search"
      bind:value={filter}
      placeholder={t('registry.search_ph')}
      aria-label={t('registry.search_ph')}
    />
    {#each categories as cat}
      <button class="cat" aria-label={categoryLabel[cat]}>{categoryLabel[cat]}</button>
    {/each}
  </div>

  {#if entries.length === 0}
    <p class="empty">{t('registry.nomatch', { query: filter })}</p>
  {:else}
    <ul class="list">
      {#each entries as entry (entry.manifest.name)}
        <li class="entry" class:installed={entry.installed} class:installing={installing === entry.manifest.name}>
          <div class="info">
            <h4>{entry.manifest.name}</h4>
            <p class="desc">{entry.manifest.description}</p>
            <p class="meta">
              v{entry.manifest.version} ·
              <span class="cat">{categoryLabel[entry.category]}</span>
              {#if entry.verified} · <span class="verified">{t('registry.verified')}</span>{/if}
              {#if entry.installed} · <span class="installed-badge">{t('registry.installed_badge')}</span>{/if}
            </p>
          </div>
          <div class="actions">
            {#if entry.installed}
              <button class="btn disabled" disabled>{t('registry.installed_btn')}</button>
            {:else}
              <button
                class="btn"
                disabled={installing !== null}
                onclick={() => install(entry)}
              >
                {installing === entry.manifest.name ? t('registry.installing') : t('plugin.install')}
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if status}
    <div class="status" class:ok={status.ok} class:error={!status.ok}>
      {status.ok ? t('registry.done_ok') : t('registry.done_failed')} {status.name}
      {#if status.error}<span class="errmsg">{status.error}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .registry {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .toolbar {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }
  .toolbar input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  .cat {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg-dim);
    font-size: 0.85em;
    cursor: pointer;
  }
  .cat:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
  .empty {
    margin: 0;
    color: var(--fg-dim);
    font-size: 0.9em;
    padding: 16px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .entry {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
  }
  .entry.installed {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 8%, var(--bg-panel));
  }
  .entry.installing {
    opacity: 0.6;
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .info h4 {
    margin: 0 0 2px;
    font-size: 1em;
    font-weight: 600;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .info .desc {
    margin: 0;
    font-size: 0.85em;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .info .meta {
    margin: 2px 0 0;
    font-size: 0.75em;
    color: var(--fg-dim);
  }
  .info .cat {
    font-size: 0.7em;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    margin-right: 4px;
    vertical-align: middle;
  }
  .info .verified {
    color: var(--ok);
    font-size: 0.7em;
  }
  .info .installed-badge {
    color: var(--ok);
    font-weight: 600;
    font-size: 0.7em;
  }
  .actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .btn {
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font: inherit;
    font-size: 0.85em;
    cursor: pointer;
  }
  .btn:hover {
    background: var(--bg-hover);
  }
  .btn.disabled {
    opacity: 0.5;
    cursor: default;
  }
  .status {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.85em;
    margin-top: 4px;
  }
  .status.ok {
    background: color-mix(in srgb, var(--ok) 10%, var(--bg-panel));
    color: var(--ok);
    border: 1px solid var(--ok);
  }
  .status.error {
    background: color-mix(in srgb, var(--danger) 10%, var(--bg-panel));
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  .status .errmsg {
    margin-left: 8px;
    font-size: 0.75em;
    opacity: 0.8;
  }
</style>
