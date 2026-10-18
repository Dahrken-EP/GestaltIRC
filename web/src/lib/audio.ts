// Audio alerts for mentions and messages. Plays a short beep through the
// browser's AudioContext when enabled and the page is unfocused.

let audioCtx: AudioContext | null = null

function getAudioCtx(): AudioContext | null {
  if (audioCtx) return audioCtx
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }
  const Ctor = w.AudioContext || w.webkitAudioContext
  if (!Ctor) return null
  try {
    audioCtx = new Ctor()
    return audioCtx
  } catch {
    return null
  }
}

// Play a short "ding" sound using two sine wave beeps.
export function playAlert(): void {
  const ctx = getAudioCtx()
  if (!ctx) return
  try {
    const now = ctx.currentTime
    const osc1 = ctx.createOscillator()
    const gain1 = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.value = 800
    gain1.gain.setValueAtTime(0.1, now)
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
    osc1.connect(gain1)
    gain1.connect(ctx.destination)
    osc1.start(now)
    osc1.stop(now + 0.1)

    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.type = 'sine'
    osc2.frequency.value = 1000
    gain2.gain.setValueAtTime(0.1, now + 0.1)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.2)
    osc2.connect(gain2)
    gain2.connect(ctx.destination)
    osc2.start(now + 0.1)
    osc2.stop(now + 0.2)
  } catch {
    // ignore audio errors
  }
}

export function audioSupported(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }
  return typeof w.AudioContext !== 'undefined' || typeof w.webkitAudioContext !== 'undefined'
}


