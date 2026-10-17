"""A scripted IRC server for driving the web client end to end.

It speaks enough IRCv3 for the features under test: message-tags (so typing,
replies and reactions work), echo-message, message redaction, away-notify.
Anything a test needs the "other people" to do is triggered by a "!" command
sent in a channel or private message.
"""
import asyncio, datetime, itertools, os, re

mid = itertools.count(1)
# Real clients that have registered, by lower-case nick, so they can talk to each other.
clients = {}
# Who is in each channel: lower-case channel -> {lower-case nick: send function}.
channels = {}
CAPS = "server-time message-tags echo-message batch message-ids away-notify multi-prefix draft/message-redaction"


def stamp(offset=0.0):
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=offset)
    return t.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def tags(extra=None, msgid=True, offset=0.0):
    parts = [f'time={stamp(offset)}']
    if msgid:
        parts.append(f'msgid=m{next(mid)}')
    for k, v in (extra or {}).items():
        parts.append(f'{k}={v}' if v != '' else k)
    return '@' + ';'.join(parts) + ' '


def parse_tags(line):
    out = {}
    m = re.match(r'^@(\S+) ', line)
    if m:
        for part in m.group(1).split(';'):
            k, _, v = part.partition('=')
            v = v.replace('\\:', ';').replace('\\s', ' ').replace('\\\\', '\\')
            out[k] = v
        line = line[m.end():]
    return out, line


def esc(v):
    return v.replace('\\', '\\\\').replace(';', '\\:').replace(' ', '\\s')


async def handle(reader, writer):
    st = {'nick': '*', 'user': False, 'capend': False, 'reg': False}

    def send(line):
        writer.write((line + '\r\n').encode())

    async def later(delay, *lines):
        await asyncio.sleep(delay)
        for l in lines:
            send(l)
        await writer.drain()

    def maybe_reg():
        if st['reg'] or not (st['user'] and st['capend'] and st['nick'] != '*'):
            return
        st['reg'] = True
        n = st['nick']
        clients[n.lower()] = send
        send(f':fake 001 {n} :Welcome to FakeNet {n}')
        send(f':fake 005 {n} NETWORK=FakeNet CHANTYPES=# PREFIX=(ov)@+ CHANMODES=beI,k,l,imnpst :are supported')
        send(f':fake 422 {n} :MOTD missing')

    def bot_say(chan, nick, text, delay=0.0, extra=None):
        asyncio.create_task(later(delay, f'{tags(extra)}:{nick}!u@h PRIVMSG {chan} :{text}'))

    def command(target, text, n):
        """A "!" message asks the fake to make somebody else do something."""
        cmd, _, arg = text.partition(' ')
        if cmd == '!msg':
            bot_say(target, 'alice', arg, 0.1)
        elif cmd == '!away':
            asyncio.create_task(later(0.1, ':carol!u@h AWAY :at lunch'))
        elif cmd == '!back':
            asyncio.create_task(later(0.1, ':carol!u@h AWAY'))
        elif cmd == '!typing':
            asyncio.create_task(later(0.1, f'@+typing=active :alice!u@h TAGMSG {target}'))
            asyncio.create_task(later(2.5, f'@+typing=done :alice!u@h TAGMSG {target}'))
        elif cmd == '!react' and arg:
            msgid, _, emoji = arg.partition(' ')
            asyncio.create_task(later(0.1, f'@+draft/react={esc(emoji)};+draft/reply={msgid} :alice!u@h TAGMSG {target}'))

    try:
        while True:
            raw = await reader.readline()
            if not raw:
                break
            ctags, line = parse_tags(raw.decode().rstrip('\r\n'))
            parts = line.split(' ', 1)
            cmd, rest = parts[0].upper(), (parts[1] if len(parts) > 1 else '')
            n = st['nick']
            if cmd == 'CAP':
                sub = rest.split(' ')[0].upper()
                if sub == 'LS':
                    send(f':fake CAP * LS :{CAPS}')
                elif sub == 'REQ':
                    send(f':fake CAP * ACK :{rest.split(" ", 1)[1].lstrip(":")}')
                elif sub == 'END':
                    st['capend'] = True
                    maybe_reg()
            elif cmd == 'NICK':
                st['nick'] = rest.lstrip(':')
                maybe_reg()
            elif cmd == 'USER':
                st['user'] = True
                maybe_reg()
            elif cmd == 'PING':
                send(f':fake PONG fake {rest}')
            elif cmd == 'JOIN':
                ch = rest.split(' ')[0]
                others = {k: v for k, v in channels.setdefault(ch.lower(), {}).items() if k != n.lower()}
                channels[ch.lower()][n.lower()] = send
                for other in others.values():
                    other(f'{tags(msgid=False)}:{n}!u@h JOIN {ch}')
                send(f'{tags(msgid=False)}:{n}!u@h JOIN {ch}')
                send(f':fake 332 {n} {ch} :Welcome! Docs at https://example.com/docs and #other')
                present = ' '.join(k for k in others)
                send(f':fake 353 {n} = {ch} :@op +carol alice {n}' + (' ' + present if present else ''))
                send(f':fake 366 {n} {ch} :End of /NAMES list')
                if ch == '#bulk':
                    # A long history, one message a second, ending a few seconds ago.
                    for i in range(800):
                        off = -(800 - i)
                        send(f'{tags(offset=off).replace("msgid=m", "msgid=bulk")}:alice!u@h PRIVMSG {ch} :bulk message {i}')
                else:
                    bot_say(ch, 'alice', f'hello {n}, welcome to {ch}', 0.5)
                    bot_say(ch, 'alice', 'see https://example.com/page and <b>not bold</b>', 0.7)
            elif cmd == 'PART':
                ch = rest.split(' ')[0]
                channels.get(ch.lower(), {}).pop(n.lower(), None)
                send(f'{tags(msgid=False)}:{n}!u@h PART {ch}')
            elif cmd == 'PRIVMSG':
                target, text = rest.split(' ', 1)
                text = text.lstrip(':')
                # Echo it back with the client-only tags it carried, plus a fresh msgid.
                client = {k: v for k, v in ctags.items() if k.startswith('+')}
                send(f'{tags({k: esc(v) for k, v in client.items()})}:{n}!u@h PRIVMSG {target} :{text}')
                peer = clients.get(target.lower())
                if peer and target.lower() != n.lower():
                    peer(f'{tags({k: esc(v) for k, v in client.items()})}:{n}!u@h PRIVMSG {target} :{text}')
                elif text.startswith('!'):
                    command(target, text, n)
                elif text.startswith('ping alice'):
                    bot_say(target, 'alice', f'{n}: pong', 0.2)
                elif not target.startswith('#'):
                    bot_say(n, target, 'got your private message', 0.2)
            elif cmd == 'TAGMSG':
                target = rest.strip()
                client = {k: v for k, v in ctags.items() if k.startswith('+')}
                line_out = f'@{";".join(k + "=" + esc(v) for k, v in client.items())} :{n}!u@h TAGMSG {target}'
                send(line_out)
                if target.startswith('#'):
                    # Everyone else in the channel sees it.
                    for who, other in list(channels.get(target.lower(), {}).items()):
                        if who != n.lower():
                            other(line_out)
                peer = clients.get(target.lower())
                if peer and target.lower() != n.lower():
                    peer(line_out)
            elif cmd == 'REDACT':
                target, msgid = rest.split(' ')[:2]
                send(f':{n}!u@h REDACT {target} {msgid}')
            elif cmd == 'WHOIS':
                send(f':fake 311 {n} {rest} u h * :Real Name')
                send(f':fake 318 {n} {rest} :End of /WHOIS list')
            elif cmd == 'QUIT':
                break
            await writer.drain()
    except ConnectionError:
        pass
    finally:
        if st['reg'] and clients.get(st['nick'].lower()) is send:
            del clients[st['nick'].lower()]
        for members in channels.values():
            members.pop(st['nick'].lower(), None)
        writer.close()


async def main():
    srv = await asyncio.start_server(handle, '127.0.0.1', int(os.environ.get('IRC_PORT', '16667')))
    async with srv:
        await srv.serve_forever()

asyncio.run(main())
