// The code that runs inside a plugin's worker, before the plugin's own code. It is plain
// JavaScript in a string because it is handed to a Worker as text. It does three things:
//
//   1. receives the message channel to the page, then takes away everything a plugin could
//      use to reach the network or other pages (the real barrier is the sandboxed frame it
//      runs in, whose content security policy forbids connections; this is a second layer);
//   2. gives the plugin the small `irc` object it is allowed to use; and
//   3. runs the plugin's code and passes events, aliases and timers to it.
//
// The plugin cannot decide what it is allowed to do: the page checks every message against
// the permissions the user granted. The checks here only make mistakes easier to understand.

export const BOOTSTRAP = String.raw`
(function (global) {
  'use strict';
  var MAX_ALIASES = 20, MAX_VALUE = 8000, MAX_TEXT = 1000;
  var port = null;
  var granted = {};
  var cache = {};
  var handlers = {};
  var aliases = {};
  var aliasCount = 0;
  var timers = {};
  var nextTimer = 1;

  var Json = global.JSON, Obj = global.Object, Str = global.String, Fn = global.Function, Err = global.Error;
  var addListener = global.addEventListener.bind(global);
  var removeListener = global.removeEventListener.bind(global);

  function post(m) { port.postMessage(m); }
  function text(v, max) {
    var s;
    try { s = typeof v === 'string' ? v : Str(v); } catch (e) { s = '[unprintable]'; }
    return s.length > max ? s.slice(0, max) : s;
  }
  function fail(where, e) {
    post({ t: 'error', text: text(where + ': ' + (e && e.message ? e.message : e), 1500) });
  }
  function need(p) {
    if (!granted[p]) throw new Err('permission "' + p + '" was not granted to this plugin');
  }

  // Everything that can reach out of the worker. A plugin has the language and nothing else.
  var REMOVE = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts',
    'Worker', 'SharedWorker', 'indexedDB', 'caches', 'CacheStorage', 'BroadcastChannel', 'postMessage', 'close',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'Notification', 'RTCPeerConnection',
    'webkitRTCPeerConnection', 'fetchLater', 'navigator', 'location'];
  function lockDown() {
    for (var i = 0; i < REMOVE.length; i++) {
      var name = REMOVE[i];
      // Some of these live on a prototype of the global object (fetch does, in Chrome), so every link of the chain is cleared.
      for (var o = global; o; o = Obj.getPrototypeOf(o)) {
        try { delete o[name]; } catch (e) { /* not removable */ }
      }
      if (name in global) {
        try { Obj.defineProperty(global, name, { value: undefined, writable: false, configurable: false }); } catch (e) { /* kept */ }
      }
    }
  }

  var irc = {
    alias: function (name, fn) {
      if (typeof name !== 'string' || typeof fn !== 'function') throw new Err('irc.alias(name, function)');
      name = name.toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(name)) throw new Err('an alias name is letters, digits and _, starting with a letter');
      if (!aliases[name]) {
        if (aliasCount >= MAX_ALIASES) throw new Err('too many aliases');
        aliasCount++;
        post({ t: 'alias', name: name });
      }
      aliases[name] = fn;
    },
    on: function (event, fn) {
      need('events');
      if (typeof event !== 'string' || typeof fn !== 'function') throw new Err('irc.on(EVENT, function)');
      event = event.toUpperCase();
      if (!handlers[event]) { handlers[event] = []; post({ t: 'on', event: event }); }
      handlers[event].push(fn);
    },
    setTimer: function (ms, fn, repeat) {
      need('timers');
      if (typeof fn !== 'function' || typeof ms !== 'number') throw new Err('irc.setTimer(milliseconds, function, repeat)');
      var id = nextTimer++;
      timers[id] = { fn: fn, repeat: !!repeat };
      post({ t: 'timer', id: id, ms: ms, repeat: !!repeat });
      return id;
    },
    clearTimer: function (id) {
      if (timers[id]) { delete timers[id]; post({ t: 'clear', id: id }); }
    },
    send: function (line, buffer, network) {
      need('send');
      post({ t: 'send', line: text(line, MAX_TEXT), buffer: buffer === undefined ? '' : text(buffer, 200), network: network === undefined ? '' : text(network, 100) });
    },
    say: function (target, message, network) {
      need('send');
      post({ t: 'send', line: '/msg ' + text(target, 100) + ' ' + text(message, MAX_TEXT - 120), buffer: '', network: network === undefined ? '' : text(network, 100) });
    },
    print: function (message, buffer, network) {
      need('output');
      post({ t: 'print', text: text(message, MAX_TEXT), buffer: buffer === undefined ? '' : text(buffer, 200), network: network === undefined ? '' : text(network, 100) });
    },
    log: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(text(arguments[i], 500));
      post({ t: 'log', text: text(parts.join(' '), 2000) });
    },
    storage: {
      get: function (key) {
        need('storage');
        return Obj.prototype.hasOwnProperty.call(cache, key) ? Json.parse(cache[key]) : undefined;
      },
      set: function (key, value) {
        need('storage');
        var s = Json.stringify(value);
        if (s === undefined) throw new Err('that value cannot be stored');
        if (text(key, 65).length > 64 || key === '') throw new Err('a storage key is 1 to 64 characters');
        if (s.length > MAX_VALUE) throw new Err('a stored value can be at most ' + MAX_VALUE + ' characters');
        cache[key] = s;
        post({ t: 'store', key: key, value: s });
      },
      delete: function (key) {
        need('storage');
        delete cache[key];
        post({ t: 'store', key: text(key, 64), value: null });
      },
      keys: function () { need('storage'); return Obj.keys(cache); }
    }
  };

  function run(source) {
    var ok = true;
    try {
      new Fn('irc', source)(irc);
    } catch (e) {
      ok = false;
      fail('while loading', e);
    }
    post({ t: 'ready', ok: ok });
  }

  function onMessage(ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'init':
        for (var i = 0; i < m.info.granted.length; i++) granted[m.info.granted[i]] = true;
        for (var k in m.storage) if (Obj.prototype.hasOwnProperty.call(m.storage, k)) cache[k] = m.storage[k];
        irc.info = Obj.freeze({ plugin: m.info.plugin, version: m.info.version, nick: m.info.nick, network: m.info.network, granted: m.info.granted.slice() });
        Obj.freeze(irc.storage);
        Obj.freeze(irc);
        run(m.source);
        break;
      case 'event': {
        var list = handlers[m.ev.event];
        if (list) for (var j = 0; j < list.length; j++) {
          try { list[j](m.ev); } catch (e) { fail('on ' + m.ev.event, e); }
        }
        break;
      }
      case 'alias':
        if (aliases[m.name]) {
          try { aliases[m.name](m.args, m.ctx, m.raw); } catch (e) { fail('/' + m.name, e); }
        }
        break;
      case 'fire': {
        var t = timers[m.id];
        if (t) {
          if (!t.repeat) delete timers[m.id];
          try { t.fn(); } catch (e) { fail('timer', e); }
        }
        break;
      }
      case 'ping':
        post({ t: 'pong', n: m.n });
        break;
    }
  }

  function start(ev) {
    if (!ev.data || ev.data.t !== 'port' || !ev.ports || !ev.ports[0]) return;
    removeListener('message', start);
    port = ev.ports[0];
    port.onmessage = onMessage;
    lockDown();
    global.onerror = function (message) { fail('uncaught', message); return true; };
    global.onunhandledrejection = function (e) { fail('unhandled promise', e && e.reason); };
  }
  addListener('message', start);
})(self);
`
