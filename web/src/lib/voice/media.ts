// Small helpers for the microphone stream that rooms and calls share.

/** Turns the microphone off, which also clears the browser's "recording" indicator. A null is nothing to stop. */
export function stopStream(stream: MediaStream | null): void {
  if (!stream) return
  for (const t of stream.getTracks()) t.stop()
}

/** Asks for the microphone. The browser's own echo cancellation and noise suppression do the clean-up. */
export function microphone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('the microphone needs a secure (https) page'))
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
}
