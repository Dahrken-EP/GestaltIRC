import { describe, expect, it, beforeEach } from 'vitest'
import { parse } from './irc/message'
import { NetworkState, parseModeChanges, type NetworkHooks } from './network.svelte'
import { settings } from './settings.svelte'

function setup(nick = 'me') {
  const sent: string[] = []
  const mentioned: string[] = []
  const hooks: NetworkHooks = { onMention: (_n, _b, m) => void mentioned.push(m.text) }
  const net = new NetworkState('id', 'u/libera', nick, (l) => void sent.push(l), hooks)
  net.nick = nick
  net.viewing = true
  const feed = (...lines: string[]) => lines.forEach((l) => net.handleMessage(parse(l)!))
  return { net, sent, mentioned, feed }
}

const T = '@time=2030-01-01T00:00:00.000Z '

beforeEach(() => {
  settings.keywords = []
})

describe('NetworkState', () => {
  it('learns the nick and ISUPPORT from the welcome', () => {
    const { net, feed } = setup('old')
    feed(
      ':b 001 me :Welcome',
      ':b 005 me NETWORK=Libera CHANTYPES=# PREFIX=(qaohv)~&@%+ CHANMODES=beI,k,l,imnpst :are supported',
    )
    expect(net.nick).toBe('me')
    expect(net.label).toBe('Libera')
    expect(net.prefixSymbols).toBe('~&@%+')
    expect(net.chanTypes).toBe('#')
  })

  it('builds a channel buffer with topic and members from the attach replay', () => {
    const { net, feed } = setup()
    feed(
      ':me!u@h JOIN #chat',
      ':b 332 me #chat :the topic',
      ':b 353 me = #chat :@op +voice plain me',
      ':b 366 me #chat :End of /NAMES list',
    )
    const buf = net.find('#chat')!
    expect(buf.kind).toBe('channel')
    expect(buf.joined).toBe(true)
    expect(buf.topic).toBe('the topic')
    expect([...buf.members.values()].map((m) => m.prefix + m.nick).sort()).toEqual(['+voice', '@op', 'me', 'plain'])
  })

  it('asks for recent history when a channel buffer is new', () => {
    const { feed, sent } = setup()
    feed(':me!u@h JOIN #chat')
    expect(sent).toContain('CHATHISTORY LATEST #chat * 100')
  })

  it('tracks joins, parts, quits and nick changes', () => {
    const { net, feed } = setup()
    feed(':me!u@h JOIN #c', ':b 353 me = #c :me')
    feed(':a!u@h JOIN #c', ':b!u@h JOIN #c')
    const buf = net.find('#c')!
    expect(buf.members.size).toBe(3)
    feed(':a!u@h NICK :a2')
    expect(buf.members.has('a2')).toBe(true)
    feed(':a2!u@h PART #c :bye', ':b!u@h QUIT :gone')
    expect([...buf.members.keys()]).toEqual(['me'])
    expect(buf.messages.map((m) => m.kind)).toEqual(['join', 'join', 'nick', 'part', 'quit'])
  })

  it('applies prefix mode changes', () => {
    const { net, feed } = setup()
    feed(':me!u@h JOIN #c', ':b 353 me = #c :me bob')
    feed(':op!u@h MODE #c +ov bob bob')
    expect(net.find('#c')!.members.get('bob')!.prefix).toBe('@+')
    feed(':op!u@h MODE #c -o bob')
    expect(net.find('#c')!.members.get('bob')!.prefix).toBe('+')
  })

  it('files private messages under the other party, including echoes', () => {
    const { net, feed } = setup()
    feed(':bob!u@h PRIVMSG me :hi', ':me!u@h PRIVMSG bob :hello back')
    const buf = net.find('bob')!
    expect(buf.kind).toBe('query')
    expect(buf.messages.map((m) => [m.nick, m.self])).toEqual([
      ['bob', false],
      ['me', true],
    ])
  })

  it('reads CTCP ACTION as an action and answers VERSION', () => {
    const { net, feed, sent } = setup()
    feed(':bob!u@h PRIVMSG #c :\x01ACTION waves\x01', ':bob!u@h PRIVMSG me :\x01VERSION\x01')
    expect(net.find('#c')!.messages[0]).toMatchObject({ kind: 'action', text: 'waves' })
    expect(sent).toContain('NOTICE bob :\x01VERSION Gestalt\x01')
  })

  it('puts server notices in the status buffer', () => {
    const { net, feed } = setup()
    feed(':irc.example.net NOTICE me :*** hello')
    expect(net.statusBuffer.messages.at(-1)).toMatchObject({ kind: 'notice', text: '*** hello' })
  })

  it('counts unread and mentions in buffers that are not on screen', () => {
    const { net, feed, mentioned } = setup()
    feed(':me!u@h JOIN #a', ':me!u@h JOIN #b')
    net.select('#a')
    feed(`${T}:x!u@h PRIVMSG #b :plain`, `${T}:x!u@h PRIVMSG #b :hey ME look`, `${T}:x!u@h PRIVMSG #a :seen`)
    const b = net.find('#b')!
    expect([b.unread, b.mentionCount]).toEqual([2, 1])
    expect(mentioned).toEqual(['hey ME look'])
    net.select('#b')
    expect([b.unread, b.mentionCount]).toEqual([0, 0])
  })

  it('treats custom keywords as mentions', () => {
    const { net, feed } = setup()
    settings.keywords = ['deploy']
    feed(':me!u@h JOIN #a', `${T}:x!u@h PRIVMSG #a :the Deploy is done`)
    expect(net.find('#a')!.mentionCount).toBe(1)
  })

  it('uses a network\'s own highlight words only on that network', () => {
    const { net, feed } = setup() // this network was added as "libera"
    settings.networkKeywords = { libera: ['gestalt'], oftc: ['elsewhere'] }
    feed(':me!u@h JOIN #a', `${T}:x!u@h PRIVMSG #a :gestalt rocks`, `${T}:x!u@h PRIVMSG #a :elsewhere too`)
    expect(net.find('#a')!.mentionCount).toBe(1)
    settings.networkKeywords = {}
  })

  it('does not notify or count history, and ignores duplicates', () => {
    const { net, feed, mentioned } = setup()
    feed(':me!u@h JOIN #a')
    net.select('')
    const line = '@time=2030-01-01T00:00:00.000Z;msgid=m1 :x!u@h PRIVMSG #a :me look'
    net.handleBatch({ type: 'chathistory', params: ['#a'], messages: [parse(line)!, parse(line)!] })
    net.handleMessage(parse(line)!)
    const buf = net.find('#a')!
    expect(buf.messages).toHaveLength(1)
    expect(mentioned).toEqual([])
  })

  it('inserts history in time order', () => {
    const { net, feed } = setup()
    feed(':me!u@h JOIN #a', '@time=2030-01-02T00:00:00.000Z :x!u@h PRIVMSG #a :new')
    net.handleBatch({
      type: 'chathistory',
      params: ['#a'],
      messages: [parse('@time=2030-01-01T00:00:00.000Z :x!u@h PRIVMSG #a :old')!],
    })
    expect(net.find('#a')!.messages.map((m) => m.text)).toEqual(['old', 'new'])
  })

  it('marks scrollback exhausted when an older page adds nothing', () => {
    const { net, feed, sent } = setup()
    feed(':me!u@h JOIN #a', '@time=2030-01-02T00:00:00.000Z :x!u@h PRIVMSG #a :one')
    const buf = net.find('#a')!
    net.loadOlder(buf)
    expect(sent.at(-1)).toBe('CHATHISTORY BEFORE #a timestamp=2030-01-02T00:00:00.000Z 100')
    expect(buf.historyLoading).toBe(true)
    net.handleBatch({ type: 'chathistory', params: ['#a'], messages: [] })
    expect(buf.historyLoading).toBe(false)
    expect(buf.historyExhausted).toBe(true)
  })

  it('submits text and commands from the active buffer', () => {
    const { net, feed, sent } = setup()
    feed(':me!u@h JOIN #a')
    net.select('#a')
    net.submit('hello\n/me waves\n/join #z')
    expect(sent.slice(-3)).toEqual(['PRIVMSG #a :hello', 'PRIVMSG #a :\x01ACTION waves\x01', 'JOIN #z'])
    feed(':me!u@h JOIN #z')
    expect(net.activeKey).toBe('#z')
  })

  it('shows an error instead of sending when no buffer is open', () => {
    const { net, sent } = setup()
    net.submit('hello')
    expect(sent).toEqual([])
    expect(net.statusBuffer.messages.at(-1)!.kind).toBe('error')
  })

  it('removes a channel buffer when we part and a query when closed', () => {
    const { net, feed, sent } = setup()
    feed(':me!u@h JOIN #a', ':bob!u@h PRIVMSG me :hi')
    net.closeBuffer(net.find('bob')!)
    expect(net.find('bob')).toBeUndefined()
    net.closeBuffer(net.find('#a')!)
    expect(sent.at(-1)).toBe('PART #a')
    feed(':me!u@h PART #a')
    expect(net.find('#a')).toBeUndefined()
  })

  it('clears members and joined state when the connection is lost', () => {
    const { net, feed } = setup()
    feed(':me!u@h JOIN #a', ':b 353 me = #a :me x')
    net.connectionLost()
    const buf = net.find('#a')!
    expect([buf.joined, buf.members.size]).toEqual([false, 0])
    feed(':me!u@h JOIN #a', ':b 353 me = #a :me y')
    expect([...buf.members.keys()].sort()).toEqual(['me', 'y'])
  })

  it('shows numeric errors in the active buffer', () => {
    const { net, feed } = setup()
    feed(':me!u@h JOIN #a')
    net.select('#a')
    feed(':b 401 me ghost :No such nick/channel')
    expect(net.find('#a')!.messages.at(-1)).toMatchObject({ kind: 'error', text: 'ghost No such nick/channel' })
  })
})

describe('registration numerics', () => {
  it('go to the status buffer even when a channel is open', () => {
    const { net, feed } = setup()
    feed(':me!u@h JOIN #a')
    net.select('#a')
    feed(':b 900 me me!u@b me :You are now logged in as me', ':b 422 me :MOTD is not available', ':b 372 me :- motd line')
    expect(net.find('#a')!.messages).toHaveLength(0)
    expect(net.statusBuffer.messages.map((m) => m.text)).toEqual([
      'me!u@b me You are now logged in as me',
      'MOTD is not available',
      '- motd line',
    ])
  })
})

describe('parseModeChanges', () => {
  const groups: [string, string, string, string] = ['beI', 'k', 'l', 'imnpst']
  const prefix = new Map([
    ['o', '@'],
    ['v', '+'],
  ])

  it('assigns arguments to the modes that take them', () => {
    expect(parseModeChanges('+ob-l+kn', ['a', 'b!*@*', 'key'], groups, prefix)).toEqual([
      { add: true, mode: 'o', arg: 'a' },
      { add: true, mode: 'b', arg: 'b!*@*' },
      { add: false, mode: 'l', arg: undefined },
      { add: true, mode: 'k', arg: 'key' },
      { add: true, mode: 'n', arg: undefined },
    ])
  })
})
