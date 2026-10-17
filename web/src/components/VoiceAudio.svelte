<script lang="ts">
  // Plays the audio of every voice room and call. It lives at the top of the page, not in a
  // channel's window, so the sound carries on when the user looks at another buffer.
  import { app } from '../lib/app.svelte'

  interface Source {
    id: string
    stream: MediaStream
    volume: number
  }

  const sources = $derived.by(() => {
    const out: Source[] = []
    for (const net of app.networks) {
      for (const buf of net.buffers) {
        for (const p of buf.voice?.participants ?? []) {
          if (p.stream) out.push({ id: `${net.id}/${buf.key}/${p.nick}`, stream: p.stream, volume: p.volume })
        }
        if (buf.call?.remote) out.push({ id: `${net.id}/${buf.key}/call`, stream: buf.call.remote, volume: buf.call.volume })
      }
    }
    return out
  })

  function play(node: HTMLAudioElement, s: Source) {
    node.srcObject = s.stream
    node.volume = s.volume
    void node.play().catch(() => undefined)
    return {
      update(next: Source) {
        if (node.srcObject !== next.stream) {
          node.srcObject = next.stream
          void node.play().catch(() => undefined)
        }
        node.volume = next.volume
      },
      destroy() {
        node.srcObject = null
      },
    }
  }
</script>

{#each sources as s (s.id)}
  <audio use:play={s} autoplay data-testid="voice-audio"></audio>
{/each}
