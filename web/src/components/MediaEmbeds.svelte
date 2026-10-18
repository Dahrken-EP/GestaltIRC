<script lang="ts">
  import { classifyLink, embedSrc, fetchPreview, mediaSrc, type LinkKind, type Preview } from '../lib/media'
  import { player, type MediaKind } from '../lib/player.svelte'
  import { settings } from '../lib/settings.svelte'
  import { t } from '../lib/i18n.svelte'

  let { links }: { links: string[] } = $props()

  let failed = $state<Record<string, boolean>>({})
  /** Why a picture or video would not load, when the bouncer could say (for example that the other site refused it). */
  let why = $state<Record<string, string>>({})

  /** The address to load a picture or video from: the bouncer's copy, or imgur itself when the user chose that. */
  function sourceOf(src: string): string {
    return settings.imgurDirect && src.startsWith('https://i.imgur.com/') ? src : mediaSrc(src)
  }

  const refused = (href: string) => /answered (403|429)/.test(why[href] ?? '') && /imgur\.com/.test(href)

  /** Marks a picture or video as failed, and asks the bouncer why: its answer to the same request says. */
  function fail(href: string, src: string) {
    failed[href] = true
    fetch(src, { credentials: 'same-origin', headers: { Range: 'bytes=0-0' } })
      .then(async (r) => {
        if (r.ok) return
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        why[href] = body?.error ?? `the bouncer answered ${r.status}`
      })
      .catch(() => (why[href] = 'the bouncer could not be reached'))
  }
  let previews = $state<Record<string, Preview | null>>({})

  /** Kinds that open a player in the corner of the window when the user presses play. */
  const playerKinds: MediaKind[] = ['youtube', 'streamable', 'twitch', 'soundcloud', 'spotify', 'vimeo']

  // What to show for each link: the kind from its address, and a preview where one is needed.
  const items = $derived(
    links.map((href) => ({ href, info: classifyLink(href) })).filter(({ info }) => {
      if (info.kind === 'image' || info.kind === 'video' || info.kind === 'audio') return settings.inlineMedia
      if (playerKinds.includes(info.kind as MediaKind)) return settings.embeds || settings.previews
      return settings.previews
    }),
  )

  // Fetch previews for the links that need one. The list renders only rows on screen,
  // so this runs only for messages the user can see.
  $effect(() => {
    for (const { href, info } of items) {
      const needsPreview = info.kind === 'link' || playerKinds.includes(info.kind as MediaKind)
      if (!needsPreview || href in previews) continue
      previews[href] = null
      fetchPreview(href).then((p) => (previews[href] = p))
    }
  })

  /** A link with no file extension can turn out to be a picture. */
  const resolvedKind = (href: string, kind: string) => {
    const p = previews[href]
    return kind === 'link' && (p?.kind === 'image' || p?.kind === 'video') ? p.kind : kind
  }

  const siteName = (u: string) => {
    try {
      return new URL(u).hostname
    } catch {
      return u
    }
  }

  /** The site's display name for a card. */
  const siteLabel = (kind: LinkKind) => {
    switch (kind) {
      case 'twitch': return 'Twitch'
      case 'soundcloud': return 'SoundCloud'
      case 'spotify': return 'Spotify'
      case 'vimeo': return 'Vimeo'
      default: return kind
    }
  }
</script>

{#each items as { href, info } (href)}
  {@const kind = resolvedKind(href, info.kind)}
  {@const p = previews[href]}
  {#if kind === 'image'}
    {#if failed[href]}
      <p class="note">{t('media.fail', { why: why[href] ? ` (${why[href]})` : '' })} <a href={href} target="_blank" rel="noopener noreferrer nofollow">{t('media.open_link')}</a>
        {#if refused(href) && !settings.imgurDirect}
          <br />{t('media.imgur_refuse')} <button class="link" onclick={() => { settings.imgurDirect = true; settings.save(); failed[href] = false }}>{t('media.load_instead')}</button> {t('media.imgur_note')}
        {/if}
      </p>
    {:else}
      <a class="media" href={href} target="_blank" rel="noopener noreferrer nofollow">
        <img src={sourceOf(info.src ?? href)} referrerpolicy="no-referrer" alt={t('media.image_of', { name: siteName(href) })} loading="lazy" decoding="async" onerror={() => fail(href, sourceOf(info.src ?? href))} />
      </a>
    {/if}
  {:else if kind === 'video'}
    {#if failed[href]}
      <p class="note">{t('media.fail_video', { why: why[href] ? ` (${why[href]})` : '' })} <a href={href} target="_blank" rel="noopener noreferrer nofollow">{t('media.open_link')}</a></p>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="media" src={sourceOf(info.src ?? href)} controls preload="metadata" playsinline onerror={() => fail(href, sourceOf(info.src ?? href))}></video>
    {/if}
  {:else if kind === 'audio'}
    {#if failed[href]}
      <p class="note">{t('media.fail_audio')} <a href={href} target="_blank" rel="noopener noreferrer nofollow">{t('media.open_link')}</a></p>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio class="sound" src={mediaSrc(href)} controls preload="none" onerror={() => (failed[href] = true)}></audio>
    {/if}
  {:else if playerKinds.includes(kind as MediaKind) && info.id}
    {#if player.is(href) && settings.embeds}
      <!-- The media plays in the corner of the window (FloatingPlayer), which stays when the channel changes. -->
      <div class="card video now">
        <div class="body">
          <span class="site">{p?.site ?? siteLabel(kind as LinkKind)}</span>
          <span class="title">{p?.title ?? href}</span>
          <span class="desc">{t('media.in_player')}</span>
          <button class="btn play" onclick={() => player.stop()}>{t('media.stop')}</button>
        </div>
      </div>
    {:else}
      <div class="card video">
        {#if p?.image}
          <img class="thumb" src={p.image} alt="" loading="lazy" decoding="async" />
        {/if}
        <div class="body">
          <span class="site">{p?.site ?? siteLabel(kind as LinkKind)}</span>
          <a class="title" href={href} target="_blank" rel="noopener noreferrer nofollow">{p?.title ?? href}</a>
          {#if p?.description}<span class="desc">{p.description}</span>{/if}
          {#if settings.embeds}
            <button
              class="btn play"
              onclick={() => player.play({
                href,
                kind: kind as MediaKind,
                id: info.id ?? '',
                title: p?.title ?? t('media.player_title'),
                soundcloudUrl: kind === 'soundcloud' ? href : undefined,
              })}
            >{t('media.play_here')}</button>
          {/if}
        </div>
      </div>
    {/if}
  {:else if p && (p.title || p.description)}
    <div class="card">
      {#if p.image}
        <img class="thumb" src={p.image} alt="" loading="lazy" decoding="async" />
      {/if}
      <div class="body">
        {#if p.site}<span class="site">{p.site}</span>{/if}
        <a class="title" href={href} target="_blank" rel="noopener noreferrer nofollow">{p.title ?? href}</a>
        {#if p.description}<span class="desc">{p.description}</span>{/if}
      </div>
    </div>
  {/if}
{/each}

<style>
  .link {
    text-decoration: underline;
    color: var(--accent);
  }
  .media {
    display: block;
    width: fit-content;
    margin-top: 4px;
    max-width: min(100%, 480px);
    max-height: 320px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    overflow: hidden;
  }
  .media img {
    display: block;
    max-width: 100%;
    max-height: 320px;
    object-fit: contain;
  }
  video.media {
    width: min(100%, 480px);
  }
  audio.sound {
    display: block;
    margin-top: 4px;
    width: min(100%, 360px);
  }
  .note {
    margin: 4px 0 0;
    color: var(--fg-dim);
    font-size: 0.9em;
  }
  .card {
    display: flex;
    gap: 10px;
    margin-top: 4px;
    max-width: min(100%, 520px);
    padding: 8px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    background: var(--bg-panel);
  }
  .thumb {
    flex: none;
    width: 96px;
    height: 72px;
    object-fit: cover;
    border-radius: 4px;
    background: var(--bg-hover);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .site {
    font-size: 0.8em;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    text-decoration: none;
  }
  .title:hover {
    text-decoration: underline;
  }
  .desc {
    color: var(--fg-dim);
    font-size: 0.9em;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .play {
    align-self: flex-start;
    margin-top: 4px;
    padding: 2px 10px;
  }
</style>
