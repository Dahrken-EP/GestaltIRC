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

  it('asks which conversations have history once connected, then for the latest of each private one', () => {
    const { net, feed, sent } = setup()
    net.setCaps(new Set(['chathistory', 'batch']))
    feed(':b 001 me :Welcome')
    expect(sent.at(-1)).toMatch(/^CHATHISTORY TARGETS timestamp=\S+ timestamp=\S+ 25$/)
    net.handleBatch({
      type: 'draft/chathistory-targets',
      params: [],
      messages: [
        parse(':bouncer CHATHISTORY TARGETS #chan 2030-01-01T00:00:00.000Z')!,
        parse(':bouncer CHATHISTORY TARGETS alice 2030-01-02T00:00:00.000Z')!,
        parse(':bouncer CHATHISTORY TARGETS bob 2030-01-03T00:00:00.000Z')!,
      ],
    })
    expect(sent.slice(-2)).toEqual(['CHATHISTORY LATEST alice * 100', 'CHATHISTORY LATEST bob * 100'])
    // What comes back opens the conversation, with the time it was said, and does not notify.
    net.handleBatch({ type: 'chathistory', params: ['alice'], messages: [parse('@time=2030-01-02T00:00:00.000Z :alice!u@h PRIVMSG me :hi')!] })
    const alice = net.find('alice')!
    expect(alice.kind).toBe('query')
    expect(alice.messages.map((m) => m.text)).toEqual(['hi'])
  })

  it('files a conversation by the other person, whatever nick I had when each message was said', () => {
    const { net, mentioned } = setup('enigma-penguin')
    // I have been enigma-penguin, then enigma-penguin|w, then enigma-penguin|sleep, and am enigma-penguin again.
    net.handleBatch({
      type: 'chathistory',
      params: ['the_decryptor'],
      messages: [
        parse('@time=2030-01-01T10:00:00.000Z :The_Decryptor!u@h PRIVMSG enigma-penguin|w :hello')!,
        parse('@time=2030-01-01T10:01:00.000Z :enigma-penguin|w!u@h PRIVMSG The_Decryptor :hi')!,
        parse('@time=2030-01-01T11:00:00.000Z :enigma-penguin|sleep!u@h PRIVMSG The_Decryptor :night')!,
        parse('@time=2030-01-01T12:00:00.000Z :enigma-penguin!u@h PRIVMSG The_Decryptor :morning')!,
        parse('@time=2030-01-01T12:01:00.000Z :The_Decryptor!u@h PRIVMSG enigma-penguin :hey')!,
      ],
    })
    // One conversation, with him, and not one with each of my old names.
    expect(net.buffers.filter((b) => b.kind === 'query').map((b) => b.name)).toEqual(['The_Decryptor'])
    const chat = net.find('the_decryptor')!
    expect(chat.messages.map((m) => [m.nick, m.text, m.self])).toEqual([
      ['The_Decryptor', 'hello', false],
      ['enigma-penguin|w', 'hi', true],
      ['enigma-penguin|sleep', 'night', true],
      ['enigma-penguin', 'morning', true],
      ['The_Decryptor', 'hey', false],
    ])
    // What I said is not a mention of me, and history never notifies.
    expect(mentioned).toEqual([])
    expect(chat.messages.filter((m) => m.mention).map((m) => m.text)).toEqual(['hello', 'hey'])
  })

  it('does not ask without chathistory', () => {
    const { feed, sent } = setup()
    feed(':b 001 me :Welcome')
    expect(sent.some((l) => l.startsWith('CHATHISTORY'))).toBe(false)
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

describe('closed private conversations', () => {
  class Mem {
    data = new Map<string, string>()
    getItem(k: string) { return this.data.get(k) ?? null }
    setItem(k: string, v: string) { this.data.set(k, v) }
    removeItem(k: string) { this.data.delete(k) }
  }
  const dm = (nick: string, text: string, time: string) => `@time=${time} :${nick}!u@h PRIVMSG me :${text}`
  const history = (net: NetworkState, target: string, ...lines: string[]) =>
    net.handleBatch({ type: 'chathistory', params: [target], messages: lines.map((l) => parse(l)!) })

  beforeEach(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = new Mem()
  })

  it('stays closed when history is fetched again after a reload', () => {
    const first = setup()
    first.feed(dm('alice', 'hello', '2020-01-01T00:00:00.000Z'))
    const buf = first.net.find('alice')!
    first.net.closeBuffer(buf)
    expect(first.net.find('alice')).toBeUndefined()

    // A new page: the same account, history replayed.
    const second = setup()
    history(second.net, 'alice', dm('alice', 'hello', '2020-01-01T00:00:00.000Z'))
    expect(second.net.find('alice')).toBeUndefined()
  })

  it('opens again for a message that arrives after it was closed, and stays open after a reload', () => {
    const first = setup()
    first.feed(dm('alice', 'hello', '2020-01-01T00:00:00.000Z'))
    first.net.closeBuffer(first.net.find('alice')!)
    first.feed(dm('alice', 'are you there?', '2021-01-01T00:00:00.000Z'))
    expect(first.net.find('alice')!.messages.map((m) => m.text)).toEqual(['are you there?'])

    const second = setup()
    history(second.net, 'alice', dm('alice', 'hello', '2020-01-01T00:00:00.000Z'), dm('alice', 'are you there?', '2021-01-01T00:00:00.000Z'))
    expect(second.net.find('alice')!.messages.map((m) => m.text)).toEqual(['hello', 'are you there?'])
  })

  it('opens again when the user starts a conversation, or a message missed while away is replayed', () => {
    const a = setup()
    a.feed(dm('alice', 'hello', '2020-01-01T00:00:00.000Z'))
    a.net.closeBuffer(a.net.find('alice')!)
    a.net.openQuery('alice')
    expect(a.net.find('alice')).toBeDefined()
    const b = setup()
    b.feed(dm('bob', 'hi', '2020-01-01T00:00:00.000Z'))
    b.net.closeBuffer(b.net.find('bob')!)
    // Sent while the page was closed, so it arrives as history, but after the closing.
    history(b.net, 'bob', dm('bob', 'ping', '2999-01-01T00:00:00.000Z'))
    expect(b.net.find('bob')!.messages.map((m) => m.text)).toEqual(['ping'])
  })

  it('does not ask for the history of a conversation closed since its last message', () => {
    const { net, feed, sent } = setup()
    net.setCaps(new Set(['chathistory', 'batch']))
    feed(dm('alice', 'hello', '2020-01-01T00:00:00.000Z'))
    net.closeBuffer(net.find('alice')!)
    sent.length = 0
    net.handleBatch({
      type: 'draft/chathistory-targets',
      params: [],
      messages: [
        parse(':bouncer CHATHISTORY TARGETS alice 2000-01-01T00:00:00.000Z')!,
        parse(':bouncer CHATHISTORY TARGETS bob 2999-01-01T00:00:00.000Z')!,
      ],
    })
    expect(sent).toEqual(['CHATHISTORY LATEST bob * 100'])
  })
})
