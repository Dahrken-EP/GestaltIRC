// What a plugin is, what it may ask for, and what it may hear about.

/**
 * What a plugin can be allowed to do. The user approves these when installing, and the host
 * (not the plugin) enforces them on every call.
 *
 *   events   hear about messages, joins, parts and the like (this includes reading chat)
 *   send     send messages and commands as the user
 *   output   write lines into a window, visible only to the user
 *   timers   run a function after a delay or repeatedly
 *   storage  keep a small amount of data between runs
 */
export const PERMISSIONS = ['events', 'send', 'output', 'timers', 'storage'] as const
export type Permission = (typeof PERMISSIONS)[number]

export const PERMISSION_TEXT: Record<Permission, string> = {
  events: 'Read what happens in your chats (messages, joins, parts, nick changes)',
  send: 'Send messages and commands as you',
  output: 'Show lines in your windows',
  timers: 'Run things on a timer',
  storage: 'Keep a small amount of data',
}

/** The events a plugin can listen for. Names are upper-case, as in the design. */
export const EVENTS = ['TEXT', 'ACTION', 'NOTICE', 'MENTION', 'JOIN', 'PART', 'QUIT', 'NICK', 'KICK', 'MODE', 'TOPIC', 'CONNECT', 'DISCONNECT'] as const
export type EventName = (typeof EVENTS)[number]

/** What a plugin says about itself. */
export interface Manifest {
  name: string
  version: string
  description: string
  permissions: Permission[]
}

/** A plugin as the user has installed it. */
export interface InstalledPlugin {
  manifest: Manifest
  source: string
  /** The permissions the user agreed to, which may be fewer than were asked for. */
  granted: Permission[]
  enabled: boolean
}

/** What a plugin hears about an event. Everything is plain data. */
export interface PluginEvent {
  event: EventName
  network: string
  /** The window name: a channel, a nick, or empty. */
  buffer: string
  /** Who did it. */
  nick: string
  /** The message, topic, reason or mode text. */
  text: string
  /** The target of a kick or the new nick of a nick change. */
  target: string
  self: boolean
  time: number
}

/** Longest source accepted, in characters. */
export const MAX_SOURCE_CHARS = 200_000
/** Largest amount of data one plugin may keep, in characters of JSON. */
export const MAX_STORAGE_CHARS = 100_000
export const MAX_STORAGE_VALUE_CHARS = 8_000
export const MAX_ALIASES = 20
export const MAX_TIMERS = 20
export const MIN_TIMER_MS = 100
/** Longest line of text a plugin may print or send. */
export const MAX_TEXT_CHARS = 1_000
