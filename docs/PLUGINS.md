# Writing plugins

A plugin is one JSON document: a name, a version, a description, the permissions it asks for, and its code.
Open **Settings, Plugins**, paste it in (or choose a file), review what it asks for, and install. **Use the
example** fills in a small working one.

```json
{
  "name": "greeter",
  "version": "1.0.0",
  "description": "Adds /greet, and counts the times you are mentioned.",
  "permissions": ["events", "send", "output", "storage"],
  "source": "irc.alias('greet', function (args, ctx) { irc.send('Hello, ' + (args[0] || ctx.nick) + '!', ctx.buffer) })"
}
```

## Permissions

You can untick any of these when installing. The page, not the plugin, checks every call, and a plugin that
keeps trying what it was refused is stopped.

| Permission | Lets the plugin |
|---|---|
| `events` | hear about messages, joins, parts and the like. This includes reading your chats. |
| `send` | send messages and commands as you |
| `output` | write lines into a window that only you see |
| `timers` | run a function after a delay, or repeatedly |
| `storage` | keep a small amount of data between runs |

## The `irc` object

| Call | What it does |
|---|---|
| `irc.alias(name, fn)` | adds the command `/name`. `fn(args, ctx)` gets the words after it and `ctx.nick` and `ctx.buffer`. It cannot replace a built-in command. |
| `irc.on(EVENT, fn)` | calls `fn(event)` for `TEXT`, `ACTION`, `NOTICE`, `MENTION`, `JOIN`, `PART`, `QUIT`, `NICK`, `KICK`, `MODE`, `TOPIC`, `CONNECT` or `DISCONNECT`. |
| `irc.setTimer(ms, fn, repeat)` | runs `fn` after `ms` milliseconds (at least 100), once or repeatedly. |
| `irc.send(line, window)` | sends a message or command as you, by the same path a typed one takes. |
| `irc.say(nick, text)` | sends a private message. |
| `irc.print(text, window)` | shows a line only you see. |
| `irc.storage.get/set/delete/keys` | keeps data between runs. |
| `irc.log(...)` | writes to the plugin's log, shown in Settings. |

An event has `event`, `network`, `buffer` (a channel, a nick, or empty), `nick` (who did it), `text` (the
message, topic, reason or mode), `target` (the victim of a kick, or the new nick), `self` and `time`.

## Where it runs, and what it cannot do

- It runs in a Web Worker inside a frame with `sandbox="allow-scripts"`. The frame has no origin of its own, so
  no cookies, no storage and no access to the page, and its content security policy forbids every connection.
  The worker removes `fetch`, `WebSocket`, `Worker`, `importScripts` and the like before the plugin's code runs.
  The browser test has a plugin try to get out by every route the authors could think of, and checks that the
  test website never hears from it.
- Lines a plugin sends go to the network. Commands that act on your browser (`/voice`, `/call`, `/direct`,
  `/clear`) are refused, a plugin cannot write in a direct chat, and it cannot take over `/ns`, `/identify`,
  `/oper` and the other commands people type passwords into. Direct chats are not passed to plugins at all.
- Plugin-sent lines do not trigger other plugins' commands, so two plugins cannot loop.
- **Limits:** a few actions a second, 20 commands, 20 timers, 100 KB of stored data, 1000 characters a line. A
  plugin that does not answer for five seconds, crashes, or floods is stopped and switched off, with the reason
  shown.

Plugins and what they store are kept on your bouncer account (and cached in this browser), so they follow you to
other browsers. The bouncer's copy replaces a browser's own when you log in. That also means the bouncer holds the
code of your plugins, and anyone who can act as your account can change it. A plugin
with `events` can read your channels, and with `send` can speak as you, so only install code you trust.

## Not built

Popups and dialogs, plugins that run on the server, and WASM hooks.
