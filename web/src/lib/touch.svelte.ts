// Touch screens have no hover, so the buttons that appear under the pointer on a desktop (reply, react, delete)
// are shown for the message that was tapped, and only that one.

/** The key of the message whose buttons are showing, or ''. */
export const touchSelection = $state({ key: '' })

/** True on a device whose main pointer cannot hover: a phone or a tablet. */
export function cannotHover(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: none)').matches
}

/** Whether a tap landed on something that does its own thing, which must not also select the message. */
export function isInteractive(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null
  return typeof el?.closest === 'function' && el.closest('a, button, input, select, textarea, audio, video, iframe, summary') !== null
}
