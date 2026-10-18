import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyLink, clearPreviews, embedSrc, fetchPreview, mediaSrc, soundcloudId, spotifyId, streamableId, twitchId, uniqueLinks, vimeoId, youtubeId } from './media'

describe('classifyLink', () => {
  it('recognises sound files by file type', () => {
    for (const ext of ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'MP3']) {
      expect(classifyLink(`https://example.org/a/song.${ext}?x=1`)).toEqual({ kind: 'audio' })
    }
  })

  it('turns an imgur page into the picture it stands for', () => {
    expect(classifyLink('https://imgur.com/AbCd123')).toEqual({ kind: 'image', src: 'https://i.imgur.com/AbCd123.jpg' })
    expect(classifyLink('https://i.imgur.com/AbCd123.png')).toEqual({ kind: 'image', src: 'https://i.imgur.com/AbCd123.png' })
    expect(classifyLink('https://i.imgur.com/AbCd123.gifv')).toEqual({ kind: 'video', src: 'https://i.imgur.com/AbCd123.mp4' })
  })

  it('leaves imgur albums, galleries and look-alike hosts as plain links', () => {
    for (const u of [
      'https://imgur.com/a/AbCd123',
      'https://imgur.com/gallery/AbCd123',
      'https://imgur.com/user/someone',
      'https://imgur.com/',
      'https://imgur.com.evil.example/AbCd123',
      'https://evil.example/imgur.com/AbCd123',
      'https://imgur.com/AbC',
    ]) {
      expect(classifyLink(u).kind).toBe('link')
    }
  })

  it('turns a giphy page or embed into its gif', () => {
    const gif = { kind: 'image', src: 'https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif' }
    expect(classifyLink('https://giphy.com/gifs/cat-funny-xT9IgzoKnwFNmISR8I')).toEqual(gif)
    expect(classifyLink('https://giphy.com/gifs/xT9IgzoKnwFNmISR8I')).toEqual(gif)
    expect(classifyLink('https://giphy.com/embed/xT9IgzoKnwFNmISR8I')).toEqual(gif)
    expect(classifyLink('https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif')).toEqual(gif)
    expect(classifyLink('https://media2.giphy.com/media/v1.Y2lkPTc/xT9IgzoKnwFNmISR8I/giphy.gif')).toEqual(gif)
  })

  it('leaves other giphy pages and look-alike hosts alone', () => {
    for (const u of ['https://giphy.com/', 'https://giphy.com/search/cats', 'https://giphy.com.evil.example/gifs/xT9IgzoKnwFNmISR8I', 'https://giphy.com/gifs/a-b!c']) {
      expect(classifyLink(u).kind).toBe('link')
    }
  })

  it('recognises images and video by file type, ignoring the query', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'PNG']) {
      expect(classifyLink(`https://example.org/a/b.${ext}?x=1#y`).kind).toBe('image')
    }
    for (const ext of ['mp4', 'webm']) expect(classifyLink(`https://example.org/clip.${ext}`).kind).toBe('video')
  })

  it('treats svg and unknown files as plain links, since svg can carry script', () => {
    for (const u of ['https://example.org/a.svg', 'https://example.org/a.pdf', 'https://example.org/', 'https://example.org/png']) {
      expect(classifyLink(u).kind).toBe('link')
    }
  })

  it('recognises video sites and extracts the id', () => {
    expect(classifyLink('https://youtu.be/dQw4w9WgXcQ')).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' })
    expect(classifyLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9')).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' })
    expect(classifyLink('https://streamable.com/abc12')).toEqual({ kind: 'streamable', id: 'abc12' })
  })

  it('is not fooled by look-alike hosts or malformed ids', () => {
    for (const u of [
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=dQw4w9WgXc"Q',
      'https://notstreamable.com/abc12',
      'https://streamable.com.evil.io/abc12',
    ]) {
      expect(classifyLink(u).kind, u).toBe('link')
    }
  })

  it('only trusts http and https, and survives junk', () => {
    for (const u of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///a.png', 'ftp://x/a.png', 'not a url', '']) {
      expect(classifyLink(u).kind, u).toBe('link')
    }
  })
})

describe('ids', () => {
  it('match the forms the bouncer accepts', () => {
    expect(youtubeId(new URL('https://www.youtube.com/shorts/dQw4w9WgXcQ'))).toBe('dQw4w9WgXcQ')
    expect(youtubeId(new URL('https://m.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe('dQw4w9WgXcQ')
    expect(youtubeId(new URL('https://www.youtube.com/@channel'))).toBe('')
    expect(streamableId(new URL('https://streamable.com/e/abc12'))).toBe('abc12')
    expect(streamableId(new URL('https://streamable.com/ABC12'))).toBe('')
  })
})

describe('new platform ids', () => {
  it('extracts twitch video, vod and clip ids', () => {
    expect(classifyLink('https://twitch.tv/videos/123456789')).toEqual({ kind: 'twitch', id: '123456789' })
    expect(classifyLink('https://www.twitch.tv/vods/987654321')).toEqual({ kind: 'twitch', id: '987654321' })
    expect(classifyLink('https://twitch.tv/clip/AbCdEf12')).toEqual({ kind: 'twitch', id: 'AbCdEf12' })
    expect(twitchId(new URL('https://twitch.tv/videos/123456789'))).toBe('123456789')
    expect(twitchId(new URL('https://twitch.tv/clip/AbCdEf12'))).toBe('AbCdEf12')
  })

  it('extracts twitch channel names for live stream links', () => {
    expect(classifyLink('https://twitch.tv/caedrel247')).toEqual({ kind: 'twitch', id: 'caedrel247' })
    expect(classifyLink('https://www.twitch.tv/caedrel247')).toEqual({ kind: 'twitch', id: 'caedrel247' })
    expect(twitchId(new URL('https://twitch.tv/caedrel247'))).toBe('caedrel247')
    expect(twitchId(new URL('https://www.twitch.tv/caedrel247'))).toBe('caedrel247')
  })

  it('is not fooled by twitch non-channel paths', () => {
    for (const u of [
      'https://twitch.tv/search',
      'https://twitch.tv/directory',
      'https://twitch.tv/about',
      'https://twitch.tv/prime',
      'https://twitch.tv/turbo',
    ]) {
      expect(classifyLink(u).kind, u).toBe('link')
    }
  })

  it('extracts soundcloud track ids', () => {
    expect(classifyLink('https://soundcloud.com/user/track-name')).toEqual({ kind: 'soundcloud', id: 'track-name' })
    expect(soundcloudId(new URL('https://soundcloud.com/user/track-name'))).toBe('track-name')
  })

  it('extracts spotify track, album and playlist ids', () => {
    expect(classifyLink('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh')).toEqual({ kind: 'spotify', id: '4iV5W9uYEdYUVa79Axb7Rh' })
    expect(classifyLink('https://open.spotify.com/album/1A2gWYaoRZg6C4D2K3sXfL')).toEqual({ kind: 'spotify', id: '1A2gWYaoRZg6C4D2K3sXfL' })
    expect(classifyLink('https://open.spotify.com/playlist/37i9dQZF1DX0UXBs16Z9o1')).toEqual({ kind: 'spotify', id: '37i9dQZF1DX0UXBs16Z9o1' })
    expect(spotifyId(new URL('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh'))).toBe('4iV5W9uYEdYUVa79Axb7Rh')
  })

  it('extracts vimeo video ids', () => {
    expect(classifyLink('https://vimeo.com/123456789')).toEqual({ kind: 'vimeo', id: '123456789' })
    expect(vimeoId(new URL('https://vimeo.com/123456789'))).toBe('123456789')
  })

  it('is not fooled by look-alike hosts or bad ids', () => {
    for (const u of [
      'https://twitch.tv.evil.example/videos/123456789',
      'https://evil.example/twitch.tv/videos/123456789',
      'https://soundcloud.com.evil.example/user/track',
      'https://open.spotify.com.evil.example/track/4iV5W9uYEdYUVa79Axb7Rh',
      'https://vimeo.com.evil.example/123456789',
      'https://open.spotify.com/track/short',
      'https://vimeo.com/notanumber',
    ]) {
      expect(classifyLink(u).kind, u).toBe('link')
    }
  })
})

describe('mediaSrc and embedSrc', () => {
  it('proxies the address, escaped', () => {
    const src = mediaSrc('https://example.org/a b.png?x=1&y=é')
    expect(src.startsWith('/api/media?u=')).toBe(true)
    expect(new URL('http://x' + src).searchParams.get('u')).toBe('https://example.org/a b.png?x=1&y=é')
  })

  it('players use the privacy-friendly hosts', () => {
    expect(embedSrc('youtube', 'dQw4w9WgXcQ')).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/)
    expect(embedSrc('streamable', 'abc12')).toMatch(/^https:\/\/streamable\.com\/e\/abc12/)
  })

  it('builds embed addresses for the new platforms', () => {
    expect(embedSrc('twitch', '123456789')).toBe('https://player.twitch.tv/?video=123456789&autoplay=true')
    expect(embedSrc('twitch', 'AbCdEf12', 'https://twitch.tv/clip/AbCdEf12')).toBe('https://clips.twitch.tv/embed?clip=AbCdEf12&autoplay=true')
    expect(embedSrc('soundcloud', 'track-name', 'https://soundcloud.com/user/track-name')).toMatch(/^https:\/\/w\.soundcloud\.com\/player\/\?url=/)
    expect(embedSrc('spotify', '4iV5W9uYEdYUVa79Axb7Rh')).toBe('https://open.spotify.com/embed/4iV5W9uYEdYUVa79Axb7Rh')
    expect(embedSrc('vimeo', '123456789')).toBe('https://player.vimeo.com/video/123456789?autoplay=true')
  })
})

describe('uniqueLinks', () => {
  it('drops repeats and keeps the first few', () => {
    expect(uniqueLinks(['a', 'b', 'a', 'c', 'd'])).toEqual(['a', 'b', 'c'])
    expect(uniqueLinks(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
    expect(uniqueLinks([])).toEqual([])
  })
})

describe('fetchPreview', () => {
  beforeEach(() => clearPreviews())
  afterEach(() => vi.unstubAllGlobals())

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  it('asks the bouncer, with the address escaped', async () => {
    const f = vi.fn().mockResolvedValue(ok({ url: 'u', kind: 'link', title: 'T' }))
    vi.stubGlobal('fetch', f)
    const p = await fetchPreview('https://example.org/a?b=c&d=e')
    expect(p?.title).toBe('T')
    expect(f.mock.calls[0]![0]).toBe('/api/preview?u=' + encodeURIComponent('https://example.org/a?b=c&d=e'))
  })

  it('asks only once for the same link, including while the first answer is pending', async () => {
    const f = vi.fn().mockResolvedValue(ok({ url: 'u', kind: 'link' }))
    vi.stubGlobal('fetch', f)
    await Promise.all([fetchPreview('https://a.example/'), fetchPreview('https://a.example/'), fetchPreview('https://a.example/')])
    await fetchPreview('https://a.example/')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('returns null for an error, a bad body, or a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))
    expect(await fetchPreview('https://a.example/')).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ no: 'kind' })))
    expect(await fetchPreview('https://b.example/')).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await fetchPreview('https://c.example/')).toBeNull()
  })

  it('treats "nothing to show" as a final answer, not a failure', async () => {
    const f = vi.fn().mockResolvedValue(ok({ kind: 'none' }))
    vi.stubGlobal('fetch', f)
    let now = 1000
    expect(await fetchPreview('https://a.example/', () => now)).toBeNull()
    now += 10 * 60_000 // far past the time failures are remembered
    expect(await fetchPreview('https://a.example/', () => now)).toBeNull()
    expect(f).toHaveBeenCalledTimes(1) // not asked again: the answer was final
  })

  it('asks again later when the bouncer says the other site failed just now', async () => {
    const f = vi.fn().mockResolvedValue(ok({ kind: 'none', retry: true }))
    vi.stubGlobal('fetch', f)
    let now = 1000
    expect(await fetchPreview('https://a.example/', () => now)).toBeNull()
    expect(await fetchPreview('https://a.example/', () => now)).toBeNull()
    expect(f).toHaveBeenCalledTimes(1) // not straight away
    now += 61_000
    await fetchPreview('https://a.example/', () => now)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('does not ask again right after a failure, but does after a while', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    vi.stubGlobal('fetch', f)
    let now = 1000
    await fetchPreview('https://a.example/', () => now)
    await fetchPreview('https://a.example/', () => now)
    expect(f).toHaveBeenCalledTimes(1)
    now += 61_000
    await fetchPreview('https://a.example/', () => now)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('runs only a few requests at a time', async () => {
    let active = 0
    let peak = 0
    const releases: (() => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            active++
            peak = Math.max(peak, active)
            releases.push(() => {
              active--
              resolve(ok({ url: 'u', kind: 'link' }))
            })
          }),
      ),
    )
    const all = Array.from({ length: 8 }, (_, i) => fetchPreview(`https://site${i}.example/`))
    await new Promise((r) => setTimeout(r, 10))
    expect(active).toBe(3)
    while (releases.length) {
      releases.shift()!()
      await new Promise((r) => setTimeout(r, 5))
    }
    await Promise.all(all)
    expect(peak).toBe(3)
  })
})
