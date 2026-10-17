// Installing the page as an app. Chromium browsers offer it through a `beforeinstallprompt` event, which
// is kept until the user asks; Safari has no such event, so there the page says how to do it by hand.

interface InstallEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallKind = 'prompt' | 'ios' | 'installed' | 'none'

export class Install {
  private event: InstallEvent | null = null
  private standalone = $state(false)
  private waiting = $state(false)
  readonly ios: boolean

  constructor() {
    const nav = typeof navigator === 'undefined' ? null : navigator
    this.ios = !!nav && /iphone|ipad|ipod/i.test(nav.userAgent) && !/crios|fxios|edgios/i.test(nav.userAgent)
    if (typeof window === 'undefined') return
    this.standalone = this.isStandalone()
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault()
      this.event = e as InstallEvent
      this.waiting = true
    })
    window.addEventListener('appinstalled', () => {
      this.event = null
      this.waiting = false
      this.standalone = true
    })
  }

  private isStandalone(): boolean {
    const nav = navigator as Navigator & { standalone?: boolean }
    return nav.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  }

  /** What the page can offer: the browser's own prompt, instructions for Safari, or nothing. */
  get kind(): InstallKind {
    if (this.standalone) return 'installed'
    if (this.waiting) return 'prompt'
    if (this.ios) return 'ios'
    return 'none'
  }

  /** Shows the browser's install prompt. Resolves to whether the user accepted. */
  async install(): Promise<boolean> {
    const e = this.event
    if (!e) return false
    this.event = null
    this.waiting = false
    await e.prompt()
    return (await e.userChoice).outcome === 'accepted'
  }
}

export const install = new Install()
