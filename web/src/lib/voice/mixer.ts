// Mixes the audio of a voice room for the people who are in it only through the host. A guest has one
// connection, to the host's browser, so the host sends them what the room sounds like, and sends the
// room what they say, on top of the host's own microphone. Nobody hears themselves: what a guest is
// sent leaves out their own voice.
//
//   to the room:  host microphone + every guest
//   to a guest:   host microphone + every other person in the room + every other guest

export interface MixerNode {
  connect(to: unknown): unknown
  disconnect(): void
}

export interface MixerDestination {
  stream: MediaStream
}

/** The part of an AudioContext this needs. The context is the page's one, shared with the meters, and is not closed here. Tests pass a fake. */
export interface MixerContext {
  createMediaStreamSource(stream: MediaStream): MixerNode
  createMediaStreamDestination(): MixerDestination & MixerNode
}

interface Source {
  node: MixerNode
}

interface Guest {
  source: Source | null
  out: MixerDestination & MixerNode
}

export class RoomMixer {
  private mic: Source | null = null
  private peers = new Map<string, Source>()
  private guests = new Map<string, Guest>()
  private room: MixerDestination & MixerNode

  constructor(private ctx: MixerContext) {
    this.room = ctx.createMediaStreamDestination()
  }

  private source(stream: MediaStream | null): Source | null {
    if (!stream || stream.getAudioTracks().length === 0) return null
    try {
      return { node: this.ctx.createMediaStreamSource(stream) }
    } catch {
      return null
    }
  }

  /** What the room hears from this browser: the microphone and the guests. New connections send this. */
  get outbound(): MediaStream {
    return this.room.stream
  }

  setMic(stream: MediaStream | null): void {
    this.mic?.node.disconnect()
    this.mic = this.source(stream)
    this.rewire()
  }

  /** Someone else in the room, heard through a connection of their own. */
  setPeer(id: string, stream: MediaStream | null): void {
    this.peers.get(id)?.node.disconnect()
    this.peers.delete(id)
    const s = this.source(stream)
    if (s) this.peers.set(id, s)
    this.rewire()
  }

  /** Makes room for a guest, and returns what they will hear. */
  addGuest(id: string): MediaStream {
    let g = this.guests.get(id)
    if (!g) {
      g = { source: null, out: this.ctx.createMediaStreamDestination() }
      this.guests.set(id, g)
      this.rewire()
    }
    return g.out.stream
  }

  /** The guest's voice arrived, or they went (null). */
  setGuestSource(id: string, stream: MediaStream | null): void {
    const g = this.guests.get(id)
    if (!g) return
    g.source?.node.disconnect()
    g.source = this.source(stream)
    this.rewire()
  }

  removeGuest(id: string): void {
    const g = this.guests.get(id)
    if (!g) return
    g.source?.node.disconnect()
    g.out.disconnect()
    this.guests.delete(id)
    this.rewire()
  }

  close(): void {
    this.mic?.node.disconnect()
    for (const p of this.peers.values()) p.node.disconnect()
    for (const g of this.guests.values()) {
      g.source?.node.disconnect()
      g.out.disconnect()
    }
    this.peers.clear()
    this.guests.clear()
    this.mic = null
    this.room.disconnect()
  }

  private rewire(): void {
    const all: Source[] = [...(this.mic ? [this.mic] : []), ...this.peers.values(), ...[...this.guests.values()].flatMap((g) => (g.source ? [g.source] : []))]
    for (const s of all) s.node.disconnect()
    if (this.mic) this.mic.node.connect(this.room)
    for (const g of this.guests.values()) if (g.source) g.source.node.connect(this.room)
    for (const [id, g] of this.guests) {
      if (this.mic) this.mic.node.connect(g.out)
      for (const p of this.peers.values()) p.node.connect(g.out)
      for (const [otherId, other] of this.guests) if (otherId !== id && other.source) other.source.node.connect(g.out)
    }
  }
}
