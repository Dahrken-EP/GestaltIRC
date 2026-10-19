// Voice over the bridge. The desktop app's Rust side owns the shared microphone (it is
// opened once, refcounted, for whichever voice chat the page is in), mixes and plays
// every far person, and reports loudness as events: `mic` for the shared microphone,
// and `pc:<connection id>` for one person's sound. What this file adds for the page is
// the card the voice rooms and calls carry in their options, and a loudness meter
// those events feed — so a room works without touching either Web Audio or getUserMedia.

import type { NativeVoicePC } from './pc'
import { streamPcId } from './pc'
import { tauriBridge, type Bridge } from './bridge'
import type { Meter } from '../voice/meter'

/** The microphone, managed in Rust. */
export interface NativeMic {
  /** Opens the shared mic (refcounted in Rust; every start is owed one stop). Throws with the reason on failure. */
  start(): Promise<void>
  /** What the microphone may send: false while muted or holding a talk key. */
  mute(muted: boolean): void
  /** Gives the ref back. The capture stops when nobody else keeps one. */
  stop(): void
}

/** What a voice room or call does with Rust instead of its own microphone and mixers. */
export interface NativeVoice {
  mic(): NativeMic
  /** Loudness of the shared microphone, fed by Rust's pass over its own capture. */
  localMeter(): Meter
  /** Loudness of one far person, by their connection's id. */
  remoteMeter(pcId: number): Meter
  /** Puts a new native connection's loudness events into the feeds. */
  wire(pc: NativeVoicePC): void
  /** What a session tells PeerSession it is sending: a marker that the bridge owns the sound. */
  ghost(): MediaStream
}

/** The feeds of this page: last loudness per source, decaying so a stale event reads as silence. */
class Feeds {
  private last = new Map<string, { level: number; at: number }>()
  /** Milliseconds after which an unanswered source counts as silent (the tick runs five times a second). */
  private static STALE_MS = 350

  feed(source: string, level: number): void {
    this.last.set(source, { level, at: Date.now() })
  }

  level(source: string): number {
    const e = this.last.get(source)
    if (!e) return 0
    return Date.now() - e.at > Feeds.STALE_MS ? 0 : e.level
  }
}

export const feeds = new Feeds()

const micOf = (br: Bridge): NativeMic => ({
  start: async () => {
    const info = (await br.invoke('mic_start')) as { ok: boolean; error: string }
    if (!info?.ok) throw new Error(info?.error || 'no microphone')
  },
  mute: (muted: boolean) => void br.invoke('mic_mute', { muted }).catch(() => {}),
  stop: () => void br.invoke('mic_stop').catch(() => {}),
})

/** The voice card for this window, or null in a plain browser. */
export function nativeVoice(): NativeVoice | null {
  const br = tauriBridge()
  if (!br) return null
  return {
    mic: () => micOf(br),
    localMeter: () => loudness('mic'),
    remoteMeter: (pcId: number) => loudness(`pc:${pcId}`),
    wire: (pc) => {
      pc.onrms = (src, level) => feeds.feed(src, level)
    },
    ghost: ghostStream,
  }
}

class LoudnessMeter implements Meter {
  constructor(private source: string) {}
  level(): number {
    return feeds.level(this.source)
  }
  close(): void {}
}

export function loudness(source: string): Meter {
  return new LoudnessMeter(source)
}

/**
 * A stream that is not media: the bridge carries no audio, so the page hands PeerSession
 * this instead of a microphone capture. Its one "track" is what makes PeerSession announce
 * a sending transceiver, which the connection turns into the Rust mic.
 */
export function ghostStream(): MediaStream {
  const track = { kind: 'audio', enabled: true, stop() {} }
  const stream = new MediaStream()
  return Object.assign(stream, {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  }) as unknown as MediaStream
}

/**
 * The page-wide meter factory: a stream that stands for one connection's sound gets that
 * connection's feed; any other stream has no native loudness, and the caller falls back
 * to the browser's analyser for it.
 */
export function nativeMeter(stream: MediaStream): Meter | null {
  const id = streamPcId(stream)
  return id === null ? null : loudness(`pc:${id}`)
}
