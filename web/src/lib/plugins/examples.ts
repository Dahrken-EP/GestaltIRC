// A small plugin to start from. It is installed with the permissions it asks for, like any other.

export const EXAMPLE_PLUGIN = JSON.stringify(
  {
    name: 'greeter',
    version: '1.0.0',
    description: 'Adds /greet, and counts the times you are mentioned.',
    permissions: ['events', 'send', 'output', 'storage'],
    source: [
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
  },
  null,
  2,
)
