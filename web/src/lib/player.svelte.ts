/**
 * The media that is playing. It lives here, not in the message that linked it, because a message is drawn only while
 * its buffer is on screen: playing inside it would stop the video on every change of channel. The player itself is in
 * FloatingPlayer, which is never taken down.
 */
export type MediaKind = 'youtube' | 'streamable' | 'twitch' | 'soundcloud' | 'spotify'

export interface Playing {
  href: string
  kind: MediaKind
  id: string
  title: string
  /** SoundCloud's widget needs the full address, not just the id. */
  soundcloudUrl?: string
}

class Player {
  current = $state<Playing | null>(null)

  play(p: Playing): void {
    this.current = p
  }

  stop(): void {
    this.current = null
  }

  is(href: string): boolean {
    return this.current?.href === href
  }
}

export const player = new Player()
