// Turns typed input into IRC lines. Known commands are mapped to their IRC
// form. Anything else is sent as a raw command, so the client does not have to
// know the server's command set.

export type Action =
  | { type: 'raw'; line: string }
  | { type: 'open'; target: string }
  | { type: 'direct'; target: string }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'error'; text: string }

export interface CommandContext {
  /** The buffer the input was typed in. Empty for the status buffer. */
  target: string
  /** True when `target` is a channel or query rather than the status buffer. */
  inBuffer: boolean
  /** Prefix characters that start a channel name, such as "#&". */
  chanTypes: string
}

/** Largest PRIVMSG text we send in one line. Leaves room for the prefix the server adds. */
export const MAX_TEXT_BYTES = 400

const encoder = new TextEncoder()

/** Splits text into pieces of at most `max` UTF-8 bytes, breaking at spaces when it can. */
export function splitText(text: string, max = MAX_TEXT_BYTES): string[] {
  const out: string[] = []
  let rest = text
  while (encoder.encode(rest).length > max) {
    let cut = 0
    let bytes = 0
    for (const ch of rest) {
      const n = encoder.encode(ch).length
      if (bytes + n > max) break
      bytes += n
      cut += ch.length
    }
    const space = rest.lastIndexOf(' ', cut)
    if (space > cut / 2) cut = space
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^ /, '')
  }
  out.push(rest)
  return out
}

function say(command: 'PRIVMSG' | 'NOTICE', target: string, text: string): Action[] {
  return splitText(text).map((t) => ({ type: 'raw', line: `${command} ${target} :${t}` }))
}

function ctcp(command: string, target: string, body: string): Action {
  return { type: 'raw', line: `PRIVMSG ${target} :\x01${command}${body ? ' ' + body : ''}\x01` }
}

/** Splits "a b c rest" into the first n words and the remainder. */
function words(s: string, n: number): string[] {
  const out: string[] = []
  let rest = s.trim()
  for (let i = 0; i < n && rest; i++) {
    const sp = rest.indexOf(' ')
    if (sp < 0) {
      out.push(rest)
      rest = ''
    } else {
      out.push(rest.slice(0, sp))
      rest = rest.slice(sp + 1).trim()
    }
  }
  if (rest) out.push(rest)
  return out
}

export const HELP = [
  'Messages: /msg TARGET TEXT, /query NICK [TEXT], /notice TARGET TEXT, /me TEXT, /ctcp TARGET CMD',
  'Channels: /join #chan [key], /part [#chan] [reason], /topic [text], /names [#chan], /list [mask], /invite NICK [#chan]',
  'Moderation: /kick NICK [reason], /ban NICK, /unban NICK, /mode [target] [modes]',
  'Info: /whois NICK, /whowas NICK, /who MASK, /time, /version, /motd, /stats, /links, /ping NICK',
  'Direct: /direct NICK opens a private chat that goes straight between your browser and theirs, and can send files',
  'Other: /nick NEW, /away [reason], /back, /quit [reason], /clear, /raw LINE',
  'Any other /command is sent to the server as it is. Start a line with // to send a literal "/".',
].join('\n')

/** Turns one line of input into actions. Multi-line input is handled by the caller. */
export function parseInput(input: string, ctx: CommandContext): Action[] {
  if (!input.startsWith('/') || input.startsWith('//')) {
    const text = input.startsWith('//') ? input.slice(1) : input
    if (!text) return []
    if (!ctx.inBuffer) return [{ type: 'error', text: 'Join a channel or open a query first. Type /help for commands.' }]
    return say('PRIVMSG', ctx.target, text)
  }

  const [cmdRaw = '', ...restParts] = input.slice(1).split(' ')
  const cmd = cmdRaw.toLowerCase()
  const args = restParts.join(' ').trim()
  const needTarget = (): Action[] | null =>
    ctx.inBuffer ? null : [{ type: 'error', text: `/${cmd} needs a channel or query to be open.` }]
  const isChan = (s: string) => !!s && ctx.chanTypes.includes(s[0]!)
  const chanOr = (first: string) => (isChan(first) ? first : ctx.target)

  switch (cmd) {
    case 'help':
      return [{ type: 'help' }]
    case 'clear':
      return [{ type: 'clear' }]
    case 'direct':
    case 'dm': {
      const nick = args.split(' ')[0] ?? ''
      if (!nick) return [{ type: 'error', text: 'Usage: /direct NICK. Opens a direct browser-to-browser chat.' }]
      return [{ type: 'direct', target: nick }]
    }
    case 'raw':
    case 'quote':
      return args ? [{ type: 'raw', line: args }] : []
    case 'join':
    case 'j': {
      if (!args) return [{ type: 'error', text: 'Usage: /join #channel [key]' }]
      return [{ type: 'raw', line: 'JOIN ' + args }]
    }
    case 'part':
    case 'leave': {
      const [first = '', ...more] = words(args, 1)
      const chan = chanOr(first)
      const reason = isChan(first) ? more.join(' ') : args
      if (!isChan(chan)) return [{ type: 'error', text: 'Usage: /part [#channel] [reason]' }]
      return [{ type: 'raw', line: `PART ${chan}` + (reason ? ` :${reason}` : '') }]
    }
    case 'quit':
      return [{ type: 'raw', line: 'QUIT' + (args ? ` :${args}` : '') }]
    case 'nick':
      return args ? [{ type: 'raw', line: 'NICK ' + args.split(' ')[0] }] : [{ type: 'error', text: 'Usage: /nick NEW' }]
    case 'msg':
    case 'privmsg':
    case 'notice': {
      const target = words(args, 1)[0] ?? ''
      const text = args.slice(target.length).trim()
      if (!target || !text) return [{ type: 'error', text: `Usage: /${cmd} TARGET TEXT` }]
      return [...say(cmd === 'notice' ? 'NOTICE' : 'PRIVMSG', target, text), ...(isChan(target) ? [] : [{ type: 'open', target } as Action])]
    }
    case 'query':
    case 'q': {
      const target = words(args, 1)[0]
      if (!target) return [{ type: 'error', text: 'Usage: /query NICK [TEXT]' }]
      const text = args.slice(target.length).trim()
      return [{ type: 'open', target }, ...(text ? say('PRIVMSG', target, text) : [])]
    }
    case 'me':
    case 'action': {
      const err = needTarget()
      if (err) return err
      return [ctcp('ACTION', ctx.target, args)]
    }
    case 'ctcp': {
      const [target, name, ...more] = words(args, 2)
      if (!target || !name) return [{ type: 'error', text: 'Usage: /ctcp TARGET COMMAND [ARGS]' }]
      return [ctcp(name.toUpperCase(), target, more.join(' '))]
    }
    case 'ping': {
      const target = args.split(' ')[0] || ''
      return target ? [ctcp('PING', target, String(Date.now()))] : [{ type: 'raw', line: 'PING :' + Date.now() }]
    }
    case 'topic': {
      const [first = ''] = words(args, 1)
      const chan = chanOr(first)
      if (!isChan(chan)) return [{ type: 'error', text: 'Usage: /topic [#channel] [new topic]' }]
      const text = isChan(first) ? args.slice(first.length).trim() : args
      return [{ type: 'raw', line: `TOPIC ${chan}` + (text ? ` :${text}` : '') }]
    }
    case 'names':
    case 'list':
    case 'whois':
    case 'whowas':
    case 'who':
    case 'time':
    case 'version':
    case 'motd':
    case 'stats':
    case 'links':
    case 'info':
    case 'lusers':
    case 'admin': {
      const bare = (cmd === 'names' || cmd === 'who') && !args && isChan(ctx.target)
      return [{ type: 'raw', line: cmd.toUpperCase() + (args ? ' ' + args : bare ? ' ' + ctx.target : '') }]
    }
    case 'mode': {
      const [first = ''] = words(args, 1)
      if (!args) return isChan(ctx.target) ? [{ type: 'raw', line: 'MODE ' + ctx.target }] : [{ type: 'error', text: 'Usage: /mode [target] [modes]' }]
      // "/mode +o nick" applies to the current channel; "/mode #chan +o nick" names it.
      if (/^[+-]/.test(first) && isChan(ctx.target)) return [{ type: 'raw', line: `MODE ${ctx.target} ${args}` }]
      return [{ type: 'raw', line: 'MODE ' + args }]
    }
    case 'kick': {
      const err = needTarget()
      if (err) return err
      const [nick = '', ...reason] = words(args, 1)
      if (!nick) return [{ type: 'error', text: 'Usage: /kick NICK [reason]' }]
      return [{ type: 'raw', line: `KICK ${ctx.target} ${nick}` + (reason.length ? ` :${reason.join(' ')}` : '') }]
    }
    case 'ban':
    case 'unban': {
      const err = needTarget()
      if (err) return err
      const mask = args.split(' ')[0]
      if (!mask) return [{ type: 'error', text: `Usage: /${cmd} NICK|MASK` }]
      const full = /[!@*]/.test(mask) ? mask : `${mask}!*@*`
      return [{ type: 'raw', line: `MODE ${ctx.target} ${cmd === 'ban' ? '+b' : '-b'} ${full}` }]
    }
    case 'invite': {
      const [nick = '', chan = ctx.target] = args.split(' ')
      if (!nick || !isChan(chan)) return [{ type: 'error', text: 'Usage: /invite NICK [#channel]' }]
      return [{ type: 'raw', line: `INVITE ${nick} ${chan}` }]
    }
    case 'away':
      return [{ type: 'raw', line: 'AWAY' + (args ? ` :${args}` : ' :Away') }]
    case 'back':
      return [{ type: 'raw', line: 'AWAY' }]
    default:
      // Unknown commands go to the server as they are.
      return [{ type: 'raw', line: cmd.toUpperCase() + (args ? ' ' + args : '') }]
  }
}
