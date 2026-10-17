<script lang="ts">
  import { classifyLink, embedSrc, fetchPreview, mediaSrc, type Preview } from '../lib/media'
  import { settings } from '../lib/settings.svelte'

  let { links }: { links: string[] } = $props()

  /** Which video players the user has clicked play on. */
  let playing = $state<Record<string, boolean>>({})
  let failed = $state<Record<string, boolean>>({})
  let previews = $state<Record<string, Preview | null>>({})

  // What to show for each link: the kind from its address, and a preview where one is needed.
  const items = $derived(
    links.map((href) => ({ href, info: classifyLink(href) })).filter(({ info }) => {
      if (info.kind === 'image' || info.kind === 'video' || info.kind === 'audio') return settings.inlineMedia
      if (info.kind === 'youtube' || info.kind === 'streamable') return settings.embeds || settings.previews
      return settings.previews
    }),
  )

  // Fetch previews for the links that need one. The list renders only rows on screen,
  // so this runs only for messages the user can see.
  $effect(() => {
    for (const { href, info } of items) {
      // A video card gets its title from the bouncer only if previews are on; the player works without.
      const needsPreview = info.kind === 'link' || ((info.kind === 'youtube' || info.kind === 'streamable') && settings.previews)
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
</script>

{#each items as { href, info } (href)}
  {@const kind = resolvedKind(href, info.kind)}
  {@const p = previews[href]}
  {#if kind === 'image'}
    {#if failed[href]}
      <p class="note">Could not load that picture. <a href={href} target="_blank" rel="noopener noreferrer nofollow">Open the link</a></p>
    {:else}
      <a class="media" href={href} target="_blank" rel="noopener noreferrer nofollow">
        <img src={mediaSrc(info.src ?? href)} alt="Picture from {siteName(href)}" loading="lazy" decoding="async" onerror={() => (failed[href] = true)} />
      </a>
    {/if}
  {:else if kind === 'video'}
    {#if failed[href]}
      <p class="note">Could not load that video. <a href={href} target="_blank" rel="noopener noreferrer nofollow">Open the link</a></p>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="media" src={mediaSrc(info.src ?? href)} controls preload="metadata" playsinline onerror={() => (failed[href] = true)}></video>
    {/if}
  {:else if kind === 'audio'}
    {#if failed[href]}
      <p class="note">Could not load that sound. <a href={href} target="_blank" rel="noopener noreferrer nofollow">Open the link</a></p>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio class="sound" src={mediaSrc(href)} controls preload="none" onerror={() => (failed[href] = true)}></audio>
    {/if}
  {:else if (kind === 'youtube' || kind === 'streamable') && info.id}
    {#if playing[href] && settings.embeds}
      <div class="player">
        <!-- YouTube refuses to play (error 153) for a page that sends no Referer, so the player gets this site's address and no more. -->
        <iframe
          src={embedSrc(kind, info.id)}
          title={p?.title ?? 'Video player'}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation"
        ></iframe>
      </div>
    {:else}
      <div class="card video">
        {#if p?.image}
          <img class="thumb" src={p.image} alt="" loading="lazy" decoding="async" />
        {/if}
        <div class="body">
          <span class="site">{p?.site ?? (kind === 'youtube' ? 'YouTube' : 'Streamable')}</span>
          <a class="title" href={href} target="_blank" rel="noopener noreferrer nofollow">{p?.title ?? href}</a>
          {#if p?.description}<span class="desc">{p.description}</span>{/if}
          {#if settings.embeds}
            <button class="btn play" onclick={() => (playing[href] = true)}>▶ Play here</button>
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
  .player {
    margin-top: 4px;
    width: min(100%, 480px);
    aspect-ratio: 16 / 9;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .player iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }
</style>
