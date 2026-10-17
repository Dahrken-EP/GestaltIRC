// Starts a plugin's worker in a sandboxed frame, and gives the host a way to talk to it.
//
// Layers, from outside in:
//   - the frame has sandbox="allow-scripts" and no "allow-same-origin", so it is a different,
//     empty origin: it cannot read this page's cookies or storage, and requests it makes to the
//     bouncer carry no credentials;
//   - its page (public/plugin-sandbox.html) has a content security policy that forbids every
//     kind of connection, which a worker made from a blob inherits;
//   - the worker's first act is to delete the things that would reach the network or other windows.
// Removing the frame ends the worker.

import { BOOTSTRAP } from './bootstrap'
import type { SandboxFactory } from './host'

export const createSandbox: SandboxFactory = ({ message, fatal }) => {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.title = 'plugin sandbox'
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
  frame.src = '/plugin-sandbox.html'

  const channel = new MessageChannel()
  channel.port1.onmessage = (e) => message(e.data)

  const fromFrame = (e: MessageEvent) => {
    const d = e.data as { t?: string; message?: unknown } | null
    if (e.source === frame.contentWindow && d?.t === 'worker-error') fatal(typeof d.message === 'string' ? d.message : 'the plugin crashed')
  }
  window.addEventListener('message', fromFrame)
  frame.addEventListener('load', () => frame.contentWindow?.postMessage({ t: 'boot', code: BOOTSTRAP }, '*', [channel.port2]))
  document.body.appendChild(frame)

  return {
    post: (m) => channel.port1.postMessage(m),
    terminate() {
      window.removeEventListener('message', fromFrame)
      channel.port1.onmessage = null
      channel.port1.close()
      frame.remove()
    },
  }
}
