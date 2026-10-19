// @vitest-environment jsdom
// The input bar is the one piece of the client where a state slip makes the app look
// broken while everything behind it works. These tests drive a real instance: typed
// text must reach what is sent, whatever key or button started the send.
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InputBar from './InputBar.svelte'
import type { Buffer, NetworkState } from '../lib/network.svelte'

afterEach(cleanup)

function network() {
  return {
    id: 1,
    status: 'connected',
    chanTypes: '#&',
    buffers: [],
    submit: vi.fn(),
    sendTyping: vi.fn(),
  } as unknown as NetworkState
}

function buffer(key: string, name: string) {
  return {
    key,
    name,
    kind: 'channel',
    p2p: undefined,
    members: new Map([
      [name.toLowerCase(), { nick: name }],
      ['helen', { nick: 'helen' }],
    ]),
    typing: [],
  } as unknown as Buffer
}

async function open(net: NetworkState, buf: Buffer, reply = null, cancel = () => {}) {
  const result = render(InputBar, { props: { net, buf, reply, oncancelreply: cancel } })
  await tick()
  return result
}

const box = (result: { getByLabelText: (selector: string) => HTMLElement }) =>
  result.getByLabelText('Message') as HTMLTextAreaElement

describe('InputBar', () => {
  it('sends what is in the box when Enter is pressed', async () => {
    const net = network()
    const result = await open(net, buffer('chan:#test', '#test'))
    await fireEvent.input(box(result), { target: { value: 'hello there' } })
    await fireEvent.keyDown(box(result), { key: 'Enter' })
    expect(net.submit).toHaveBeenCalled()
    expect((net.submit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('hello there')
  })

  it('sends it from the send button too, and the button sits idle while the box is empty', async () => {
    const net = network()
    const result = await open(net, buffer('chan:#test', '#test'))
    const send = result.getByLabelText('Send') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await fireEvent.input(box(result), { target: { value: 'from the button' } })
    expect(send.disabled).toBe(false)
    await fireEvent.click(send)
    expect((net.submit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('from the button')
  })

  it('completes a nick against the text as typed, not as the state last saw it', async () => {
    const net = network()
    const result = await open(net, buffer('chan:#test', '#test'))
    const area = box(result)
    await fireEvent.input(area, { target: { value: 'say hel' } })
    area.setSelectionRange(7, 7)
    await fireEvent.keyDown(area, { key: 'Tab' })
    await tick()
    expect(area.value).toContain('helen')
  })

  it('keeps each buffer its own draft when switching between two channels', async () => {
    const net = network()
    const first = buffer('chan:#one', '#one')
    const second = buffer('chan:#two', '#two')
    const result = await open(net, first)
    await fireEvent.input(box(result), { target: { value: 'draft one' } })

    await result.rerender({ net, buf: second, reply: null, oncancelreply: () => {} })
    await tick()
    expect(box(result).value).toBe('')

    await fireEvent.input(box(result), { target: { value: 'draft two' } })
    await result.rerender({ net, buf: first, reply: null, oncancelreply: () => {} })
    await tick()
    expect(box(result).value).toBe('draft one')
  })

  it('leaves nothing behind after a send: the next draft starts empty', async () => {
    const net = network()
    const result = await open(net, buffer('chan:#test', '#test'))
    await fireEvent.input(box(result), { target: { value: 'gone' } })
    await fireEvent.keyDown(box(result), { key: 'Enter' })
    await tick()
    expect(box(result).value).toBe('')
  })
})
