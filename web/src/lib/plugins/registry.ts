// A curated registry of server-side plugins. Each entry has a manifest plus the
// plugin source, so users can install with one click from the Plugins panel.
// Plugins here are vetted and safe; they run in the same sandbox as user-installed
// plugins and only receive the permissions they ask for.

import type { InstalledPlugin, Manifest } from './types'

export interface RegistryPlugin {
  manifest: Manifest
  source: string
  category: 'utility' | 'moderation' | 'fun' | 'info'
  verified: boolean
}

const makePlugin = (
  manifest: Manifest,
  source: string,
  category: RegistryPlugin['category'],
  verified = true,
): RegistryPlugin => ({ manifest, source, category, verified })

export const REGISTRY_PLUGINS: RegistryPlugin[] = [
  makePlugin(
    {
      name: 'greeter',
      version: '1.0.0',
      description: 'Adds /greet [nick] to say hello, and counts mentions.',
      permissions: ['events', 'send', 'output', 'storage'],
    },
    [
      "// /greet [nick] says hello in the window you are in.",
      "irc.alias('greet', function (args, ctx) {",
      "  var who = args[0] || ctx.nick;",
      "  irc.send('Hello, ' + who + '!', ctx.buffer);",
      "});",
      "",
      "// Counts mentions, and keeps the count between runs.",
      "irc.on('MENTION', function (e) {",
      "  var n = (irc.storage.get('mentions') || 0) + 1;",
      "  irc.storage.set('mentions', n);",
      "  irc.print('Mentioned ' + n + ' time(s) since this plugin was installed. Last by ' + e.nick + '.', e.buffer);",
      "});",
    ].join('\n'),
    'utility',
  ),

  makePlugin(
    {
      name: 'echo',
      version: '1.0.0',
      description: 'Repeats back anything said to it with /echo.',
      permissions: ['events', 'send'],
    },
    [
      "// /echo <text> repeats your message back.",
      "irc.alias('echo', function (args, ctx) {",
      "  irc.send(args.join(' '), ctx.buffer);",
      "});",
    ].join('\n'),
    'fun',
  ),

  makePlugin(
    {
      name: 'uptime',
      version: '1.0.0',
      description: 'Adds /uptime to show how long the bot has been running.',
      permissions: ['events', 'send'],
    },
    [
      "// /uptime shows how long the plugin has been running.",
      "var started = Date.now();",
      "irc.alias('uptime', function () {",
      "  var ms = Date.now() - started;",
      "  var s = Math.floor(ms / 1000) % 60;",
      "  var m = Math.floor(ms / 60000) % 60;",
      "  var h = Math.floor(ms / 3600000);",
      "  irc.send('Uptime: ' + h + 'h ' + m + 'm ' + s + 's', ctx.buffer);",
      "});",
    ].join('\n'),
    'info',
  ),

  makePlugin(
    {
      name: 'nickwatch',
      version: '1.0.0',
      description: 'Announces when someone changes their nick.',
      permissions: ['events', 'output'],
    },
    [
      "// Announces nick changes in the window where they happen.",
      "irc.on('NICK', function (e) {",
      "  irc.print(e.nick + ' is now known as ' + e.target, e.buffer);",
      "});",
    ].join('\n'),
    'moderation',
  ),

  makePlugin(
    {
      name: 'linklog',
      version: '1.0.0',
      description: 'Logs all links posted in channels to storage.',
      permissions: ['events', 'storage'],
    },
    [
      "// Logs every link posted in a channel to storage.",
      "irc.on('TEXT', function (e) {",
      "  var links = e.text.match(/https?:\\/\\/[^\\s]+/g) || [];",
      "  if (links.length === 0) return;",
      "  var log = irc.storage.get('links') || [];",
      "  links.forEach(function (l) {",
      "    log.push({ nick: e.nick, channel: e.buffer, link: l, time: e.time });",
      "  });",
      "  irc.storage.set('links', log);",
      "});",
    ].join('\n'),
    'utility',
  ),

  makePlugin(
    {
      name: 'awaylog',
      version: '1.0.0',
      description: 'Logs when people go away or come back.',
      permissions: ['events', 'output'],
    },
    [
      "// Logs away/back status changes.",
      "irc.on('AWAY', function (e) {",
      "  if (e.text) {",
      "    irc.print(e.nick + ' is now away: ' + e.text, e.buffer);",
      "  } else {",
      "    irc.print(e.nick + ' is no longer away', e.buffer);",
      "  }",
      "});",
    ].join('\n'),
    'moderation',
  ),

  makePlugin(
    {
      name: 'topicwatch',
      version: '1.0.0',
      description: 'Announces when the channel topic changes.',
      permissions: ['events', 'output'],
    },
    [
      "// Announces topic changes.",
      "irc.on('TOPIC', function (e) {",
      "  irc.print(e.nick + ' changed the topic: ' + e.text, e.buffer);",
      "});",
    ].join('\n'),
    'info',
  ),

  makePlugin(
    {
      name: 'helloworld',
      version: '1.0.0',
      description: 'Says hello when you join a channel.',
      permissions: ['events', 'send'],
    },
    [
      "// Says hello when you join a channel.",
      "irc.on('JOIN', function (e) {",
      "  if (e.nick === irc.info.nick) {",
      "    irc.send('Hello everyone!', e.buffer);",
      "  }",
      "});",
    ].join('\n'),
    'fun',
  ),
]

export function registryPluginToInstalled(p: RegistryPlugin): InstalledPlugin {
  return {
    manifest: p.manifest,
    source: p.source,
    granted: [...p.manifest.permissions],
    enabled: true,
  }
}
