// Small helpers for the microphone stream that rooms and calls share.

/** Turns the microphone off, which also clears the browser's "recording" indicator. */
export function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop()
}
