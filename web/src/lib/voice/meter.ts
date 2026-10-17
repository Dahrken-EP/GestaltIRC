// Loudness of an audio stream, for the "is speaking" indicator.

export interface Meter {
  /** Loudness from 0 (silence) to 1. */
  level(): number
  close(): void
}

export type MeterFactory = (stream: MediaStream) => Meter

let context: AudioContext | null = null

/** One AudioContext serves every meter. Browsers only allow it after a click, so the first call comes from one. */
function audio(): AudioContext | null {
  if (!context) {
    if (typeof window === 'undefined') return null
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    context = new Ctor()
  }
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  return context
}

/** Prepares audio inside a click, before any waiting, so the browser lets it run. */
export function primeAudio(): void {
  audio()
}

export const audioMeter: MeterFactory = (stream) => {
  const ctx = audio()
  if (!ctx || stream.getAudioTracks().length === 0) return { level: () => 0, close() {} }
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048 // about 43 ms of sound, so polling twenty times a second misses nothing
  source.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  return {
    level() {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
      return peak / 128
    },
    close() {
      source.disconnect()
      analyser.disconnect()
    },
  }
}

/** Turns a loudness into speaking or not, holding "speaking" a little after the sound stops so it does not flicker. */
export class Speaking {
  private last = -Infinity
  constructor(
    private threshold = 0.03,
    private holdMs = 500,
  ) {}

  update(level: number, now: number): boolean {
    if (level >= this.threshold) this.last = now
    return now - this.last < this.holdMs
  }
}
