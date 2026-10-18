// Deciding what to show for a link, and asking the bouncer for it. The browser
// never contacts the other site: pictures and video come from /api/media, and
// titles and thumbnails from /api/preview.

export type LinkKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'youtube'
  | 'streamable'
  | 'twitch'
  | 'soundcloud'
  | 'spotify'
  | 'vimeo'
  | 'link'

export interface LinkInfo {
  kind: LinkKind
  /** The video or clip id for youtube, streamable, twitch and vimeo. For soundcloud and spotify it is the track/item id. */
  id?: string
  /** For imgur and giphy links: the address of the file itself, which is not the address that was posted. */
  src?: string
}

export interface Preview {
  url: string
  kind: 'link' | 'image' | 'video' | 'audio' | 'youtube' | 'streamable' | 'twitch' | 'soundcloud' | 'spotify' | 'vimeo' | 'none'
  title?: string
  description?: string
  site?: string
  /** An address on the bouncer, already proxied. */
  image?: string
  id?: string
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i
const VIDEO_EXT = /\.(mp4|webm)$/i
const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|flac|m4a)$/i
const IMGUR_ID = /^[A-Za-z0-9]{5,8}$/
const GIPHY_ID = /^[A-Za-z0-9]{6,32}$/
const YT_ID = /^[A-Za-z0-9_-]{11}$/
const STREAMABLE_ID = /^[a-z0-9]{4,12}$/
const TWITCH_ID = /^[a-zA-Z0-9_-]{2,25}$/
const SOUNDCLOUD_ID = /^[a-zA-Z0-9_-]+$/
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/
const VIMEO_ID = /^\d{6,10}$/

/** The address of a proxied copy of `url`. */
export function mediaSrc(url: string): string {
  return '/api/media?u=' + encodeURIComponent(url)
}

/** The video id in a YouTube link, or '' when it is not a video link. */
export function youtubeId(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
  let id = ''
  const path = u.pathname.replace(/^\/+|\/+$/g, '')
  if (host === 'youtu.be') id = path
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    if (path === 'watch') id = u.searchParams.get('v') ?? ''
    else if (/^(shorts|embed|live)\//.test(path)) id = path.split('/')[1] ?? ''
  }
  return YT_ID.test(id) ? id : ''
}

/** The clip id in a Streamable link, or ''. */
export function streamableId(u: URL): string {
  if (u.hostname.toLowerCase().replace(/^www\./, '') !== 'streamable.com') return ''
  const id = u.pathname.replace(/^\/+|\/+$/g, '').replace(/^e\//, '')
  return STREAMABLE_ID.test(id) ? id : ''
}

/** The video, VOD, clip, or channel name in a Twitch link, or ''. Handles /videos/, /vods/, /clip/ and channel pages. */
export function twitchId(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'twitch.tv') return ''
  const path = u.pathname.replace(/^\/+|\/+$/g, '')
  const parts = path.split('/')
  // twitch.tv/videos/123456789, twitch.tv/vods/123456789
  if ((parts[0] === 'videos' || parts[0] === 'vods') && parts.length >= 2) {
    const id = parts[1] ?? ''
    return TWITCH_ID.test(id) ? id : ''
  }
  // twitch.tv/clip/AbCdEf
  if (parts[0] === 'clip' && parts.length >= 2) {
    const id = parts[1] ?? ''
    return TWITCH_ID.test(id) ? id : ''
  }
  // twitch.tv/CHANNELNAME (channel page / live stream). Single path segment,
  // not a known non-channel path.
  if (parts.length === 1 && parts[0] && !twitchNonChannelPaths.has(parts[0])) {
    const name = parts[0]
    // Twitch usernames are alphanumeric with underscores, 4-25 characters.
    if (/^[a-zA-Z0-9_]{4,25}$/.test(name)) {
      return name
    }
  }
  return ''
}

// Twitch URL paths that are not channel pages.
const twitchNonChannelPaths = new Set([
  'videos', 'vods', 'clip', 'clips', 'search', 'directory', 'popout',
  'login', 'signup', 'about', 'terms', 'privacy', 'ad', 'extensions',
  'messenger', 'settings', 'upload', 'turbo', 'prime', 'drops',
  'watch', 'gear', 'conquer', 'all-categories',
])

/** The track id in a SoundCloud link, or ''. Keeps the whole path when it looks like a user/track. */
export function soundcloudId(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'soundcloud.com') return ''
  const path = u.pathname.replace(/^\/+|\/+$/g, '')
  const parts = path.split('/').filter(Boolean)
  // soundcloud.com/user/track-name  (at least two parts, not a set/playlist page alone)
  if (parts.length >= 2 && parts[0] !== 'sets' && parts[0] !== 'stream') {
    const id = parts[parts.length - 1] ?? ''
    return SOUNDCLOUD_ID.test(id) ? id : ''
  }
  return ''
}

/** The item id in a Spotify link, or ''. Handles /track/, /album/, /playlist/. */
export function spotifyId(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'open.spotify.com' && host !== 'spotify.com') return ''
  const path = u.pathname.replace(/^\/+|\/+$/g, '')
  const parts = path.split('/')
  // open.spotify.com/track/ID, /album/ID, /playlist/ID
  if ((parts[0] === 'track' || parts[0] === 'album' || parts[0] === 'playlist') && parts.length >= 2) {
    const id = ((parts[1] ?? '').split('?')[0] ?? '')
    return SPOTIFY_ID.test(id) ? id : ''
  }
  return ''
}

/** The video id in a Vimeo link, or ''. */
export function vimeoId(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'vimeo.com') return ''
  const path = u.pathname.replace(/^\/+|\/+$/g, '')
  const id = path.split('/')[0] ?? ''
  return VIMEO_ID.test(id) ? id : ''
}

/**
 * Imgur and Giphy pages are not files, but each has a file at a known address. Returns that
 * file, or null when the link is something else (an album, a gallery, a profile).
 */
export function hostedFile(u: URL): { kind: 'image' | 'video'; src: string } | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const parts = u.pathname.split('/').filter(Boolean)
  if (host === 'imgur.com' || host === 'i.imgur.com') {
    if (parts.length !== 1) return null
    const m = /^([A-Za-z0-9]+)(?:\.(\w+))?$/.exec(parts[0] ?? '')
    const name = m?.[1] ?? ''
    if (!m || !IMGUR_ID.test(name)) return null
    const ext = (m[2] ?? '').toLowerCase()
    if (ext === 'gifv' || ext === 'mp4') return { kind: 'video', src: `https://i.imgur.com/${name}.mp4` }
    if (ext === '' && host === 'imgur.com') return { kind: 'image', src: `https://i.imgur.com/${name}.jpg` }
    if (/^(png|jpe?g|gif|webp)$/.test(ext)) return { kind: 'image', src: `https://i.imgur.com/${name}.${ext}` }
    return null
  }
  if (host === 'giphy.com' || host === 'media.giphy.com' || /^media\d*\.giphy\.com$/.test(host) || host === 'i.giphy.com') {
    let id = ''
    if (host === 'giphy.com' && parts[0] === 'gifs' && parts.length >= 2) id = (parts[parts.length - 1] ?? '').split('-').pop() ?? ''
    else if (host === 'giphy.com' && parts[0] === 'embed' && parts.length >= 2) id = parts[1] ?? ''
    else if (host === 'giphy.com' && parts[0] === 'stickers' && parts.length >= 2) id = (parts[parts.length - 1] ?? '').split('-').pop() ?? ''
    else if (parts[0] === 'media' && parts.length >= 2) {
      // media.giphy.com/media/ID/giphy.gif, and the newer media/v1.xxx/ID/giphy.gif
      id = /^v\d/.test(parts[1] ?? '') ? (parts[2] ?? '') : (parts[1] ?? '')
    } else if (host === 'i.giphy.com' && parts.length === 1) id = (parts[0] ?? '').replace(/\.\w+$/, '')
    if (!GIPHY_ID.test(id)) return null
    return { kind: 'image', src: `https://media.giphy.com/media/${id}/giphy.gif` }
  }
  return null
}

/** Sorts a link into what can be shown inline. Anything unrecognised is a plain link. */
export function classifyLink(href: string): LinkInfo {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return { kind: 'link' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'link' }
  const yt = youtubeId(u)
  if (yt) return { kind: 'youtube', id: yt }
  const st = streamableId(u)
  if (st) return { kind: 'streamable', id: st }
  const tc = twitchId(u)
  if (tc) return { kind: 'twitch', id: tc }
  const sc = soundcloudId(u)
  if (sc) return { kind: 'soundcloud', id: sc }
  const sp = spotifyId(u)
  if (sp) return { kind: 'spotify', id: sp }
  const vm = vimeoId(u)
  if (vm) return { kind: 'vimeo', id: vm }
  const hosted = hostedFile(u)
  if (hosted) return hosted
  if (IMAGE_EXT.test(u.pathname)) return { kind: 'image' }
  if (VIDEO_EXT.test(u.pathname)) return { kind: 'video' }
  if (AUDIO_EXT.test(u.pathname)) return { kind: 'audio' }
  return { kind: 'link' }
}

/** The address of the player to load once the user clicks play. Never loaded before that. */
export function embedSrc(kind: LinkKind, id: string, href?: string): string {
  switch (kind) {
    case 'youtube':
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`
    case 'streamable':
      return `https://streamable.com/e/${id}?autoplay=1`
    case 'twitch':
      // A clip uses the clips embed, a channel page uses ?channel=, anything else
      // (video/VOD) uses ?video=.
      if (id && href && /clip/i.test(href)) {
        return `https://clips.twitch.tv/embed?clip=${id}&autoplay=true`
      }
      const isChannel = id && href && !/(videos|vods)\//i.test(href)
      return `https://player.twitch.tv/?${isChannel ? 'channel' : 'video'}=${id}&autoplay=true`
    case 'soundcloud':
      // SoundCloud's widget needs the full address, so the caller passes it.
      return href
        ? `https://w.soundcloud.com/player/?url=${encodeURIComponent(href)}&auto_play=true&hide_related=false&show_comments=true&show_user=true&show_reposts=false`
        : `https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/${id}&auto_play=true`
    case 'spotify':
      return `https://open.spotify.com/embed/${id}`
    case 'vimeo':
      return `https://player.vimeo.com/video/${id}?autoplay=true`
    default:
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`
  }
}

/** Distinct web addresses from a message, in order, at most `max` of them. */
export function uniqueLinks(hrefs: string[], max = 3): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of hrefs) {
    if (seen.has(h)) continue
    seen.add(h)
    out.push(h)
    if (out.length >= max) break
  }
  return out
}

// --- fetching previews ---

/** At most this many preview requests run at once, so a screen of links does not flood the bouncer. */
const MAX_CONCURRENT = 3
/** A preview that failed is not asked for again for this long. */
const FAILURE_MEMORY_MS = 60_000

const cache = new Map<string, { value: Promise<Preview | null>; failedAt?: number }>()
let running = 0
const queue: (() => void)[] = []

function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => {
      running++
      resolve(() => {
        running--
        queue.shift()?.()
      })
    }
    if (running < MAX_CONCURRENT) go()
    else queue.push(go)
  })
}

/** What came back: the preview, and whether to remember the answer for good. */
interface Answer {
  preview: Preview | null
  /** False for a failure, which is worth trying again later. */
  final: boolean
}

async function request(url: string): Promise<Answer> {
  const release = await slot()
  try {
    const res = await fetch('/api/preview?u=' + encodeURIComponent(url), { credentials: 'same-origin' })
    if (!res.ok) return { preview: null, final: false }
    const data = (await res.json()) as Preview
    if (!data || typeof data.kind !== 'string') return { preview: null, final: false }
    // The bouncer says "none" when a link simply has nothing to show. That is an answer.
    // "retry" means the other site failed just now, so it is worth asking again after a while.
    return data.kind === 'none' ? { preview: null, final: !(data as { retry?: boolean }).retry } : { preview: data, final: true }
  } catch {
    return { preview: null, final: false }
  } finally {
    release()
  }
}

/** Asks the bouncer for a preview. Answers are remembered, and so are recent failures. */
export function fetchPreview(url: string, now: () => number = Date.now): Promise<Preview | null> {
  const hit = cache.get(url)
  if (hit && (hit.failedAt === undefined || now() - hit.failedAt < FAILURE_MEMORY_MS)) return hit.value
  const entry: { value: Promise<Preview | null>; failedAt?: number } = {
    value: request(url).then((a) => {
      if (!a.final) entry.failedAt = now()
      return a.preview
    }),
  }
  cache.set(url, entry)
  // Keep the memory flat in a long session.
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  return entry.value
}

/** Forgets everything. For tests, and when a user logs out. */
export function clearPreviews(): void {
  cache.clear()
}
