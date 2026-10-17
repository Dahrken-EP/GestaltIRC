import { describe, expect, it } from 'vitest'
import { RoomMixer, type MixerContext, type MixerDestination, type MixerNode } from './mixer'

class Node implements MixerNode {
  to = new Set<unknown>()
  constructor(public name: string) {}
  connect(to: unknown) {
    this.to.add(to)
  }
  disconnect() {
    this.to.clear()
  }
}

function stream(name: string, audio = true): MediaStream {
  return { name, getAudioTracks: () => (audio ? [{}] : []) } as unknown as MediaStream
}

function context() {
  const sources = new Map<string, Node>()
  const dests: Array<Node & MixerDestination> = []
  const ctx: MixerContext = {
    createMediaStreamSource(s) {
      const n = new Node((s as unknown as { name: string }).name)
      sources.set(n.name, n)
      return n
    },
    createMediaStreamDestination() {
      const d = Object.assign(new Node('dest' + dests.length), { stream: stream('out' + dests.length) })
      dests.push(d)
      return d
    },
  }
  return { ctx, sources, dests }
}

/** Which of the named sources feed a destination. */
const feeding = (sources: Map<string, Node>, dest: unknown) => [...sources.values()].filter((n) => n.to.has(dest)).map((n) => n.name).sort()

describe('RoomMixer', () => {
  it('sends the room the microphone and the guests', () => {
    const { ctx, sources, dests } = context()
    const m = new RoomMixer(ctx)
    m.setMic(stream('mic'))
    m.addGuest('sam')
    m.setGuestSource('sam', stream('sam-voice'))
    expect(feeding(sources, dests[0])).toEqual(['mic', 'sam-voice'])
    expect(m.outbound).toBe(dests[0]!.stream)
  })

  it('sends a guest everything but their own voice', () => {
    const { ctx, sources, dests } = context()
    const m = new RoomMixer(ctx)
    m.setMic(stream('mic'))
    m.setPeer('alice', stream('alice-voice'))
    const toSam = m.addGuest('sam')
    m.addGuest('pat')
    m.setGuestSource('sam', stream('sam-voice'))
    m.setGuestSource('pat', stream('pat-voice'))
    const samOut = dests.find((d) => d.stream === toSam)!
    expect(feeding(sources, samOut)).toEqual(['alice-voice', 'mic', 'pat-voice'])
    const patOut = dests.find((d) => d !== samOut && d !== dests[0])!
    expect(feeding(sources, patOut)).toEqual(['alice-voice', 'mic', 'sam-voice'])
  })

  it('follows people joining and leaving the room', () => {
    const { ctx, sources, dests } = context()
    const m = new RoomMixer(ctx)
    m.setMic(stream('mic'))
    const toSam = m.addGuest('sam')
    const samOut = dests.find((d) => d.stream === toSam)!
    m.setPeer('alice', stream('alice-voice'))
    expect(feeding(sources, samOut)).toEqual(['alice-voice', 'mic'])
    m.setPeer('alice', null)
    expect(feeding(sources, samOut)).toEqual(['mic'])
    m.setGuestSource('sam', stream('sam-voice'))
    m.removeGuest('sam')
    expect(feeding(sources, dests[0])).toEqual(['mic'])
  })

  it('takes a new microphone, and skips a stream with no audio', () => {
    const { ctx, sources, dests } = context()
    const m = new RoomMixer(ctx)
    m.setMic(stream('mic1'))
    m.setMic(stream('mic2'))
    expect(feeding(sources, dests[0])).toEqual(['mic2'])
    m.setPeer('quiet', stream('quiet', false))
    m.setMic(null)
    expect(feeding(sources, dests[0])).toEqual([])
  })

  it('ignores a guest it does not know, and lets go of everything on close', () => {
    const { ctx, sources, dests } = context()
    const m = new RoomMixer(ctx)
    m.setGuestSource('nobody', stream('x'))
    m.removeGuest('nobody')
    m.setMic(stream('mic'))
    m.close()
    expect(feeding(sources, dests[0])).toEqual([])
  })
})
