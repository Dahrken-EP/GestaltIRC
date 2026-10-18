<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '../lib/api'
  import { settings } from '../lib/settings.svelte'

  interface Notification {
    id: number
    kind: string
    network: string
    buffer: string
    title: string
    body: string
    read: boolean
    created: number
  }

  let notifications = $state<Notification[]>([])
  let unreadCount = $state(0)
  let loading = $state(false)
  let open = $state(false)

  async function load() {
    loading = true
    try {
      const [all, unread] = await Promise.all([api.notifications(), api.notificationsUnread()])
      notifications = all
      unreadCount = unread.length
    } catch {
      // notifications are a bonus; failure is not fatal
    } finally {
      loading = false
    }
  }

  async function markRead() {
    try {
      await api.markNotificationsRead()
      unreadCount = 0
      for (const n of notifications) n.read = true
    } catch {
      // best effort
    }
  }

  function kindLabel(n: Notification) {
    switch (n.kind) {
      case 'pm': return 'Private message'
      case 'status': return 'Server status'
      case 'security': return 'Security'
      case 'plugin': return 'Plugin'
      default: return n.kind
    }
  }

  function kindColor(n: Notification) {
    switch (n.kind) {
      case 'pm': return 'var(--ok)'
      case 'status': return 'var(--accent)'
      case 'security': return 'var(--warn)'
      case 'plugin': return 'var(--fg-dim)'
      default: return 'var(--fg-dim)'
    }
  }

  function timeAgo(created: number): string {
    const ms = Date.now() - created
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
    return `${Math.round(ms / 86_400_000)}d ago`
  }

  onMount(load)
</script>

<div class="notification-panel" class:open={open}>
  <button
    class="bell"
    aria-label="Notifications"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="notifications-list"
    onclick={() => { open = !open; if (open) markRead() }}
    data-testid="notifications-bell"
  >
    <span class="bell-icon">🔔</span>
    {#if unreadCount > 0}
      <span class="badge" aria-label="{unreadCount} unread">{unreadCount}</span>
    {/if}
  </button>

  <div id="notifications-list" class="drawer" class:open={open} role="menu" aria-label="Activity feed">
    <div class="drawer-header">
      <h3>Activity</h3>
      <button class="btn" onclick={markRead} disabled={unreadCount === 0}>Mark all as read</button>
    </div>
    {#if loading}
      <p class="note">Loading…</p>
    {:else if notifications.length === 0}
      <p class="note">No notifications yet.</p>
    {:else}
      <ul class="list">
        {#each notifications as n (n.id)}
          <li class="item" class:unread={!n.read} role="menuitem">
            <span class="dot" style:background={kindColor(n)} aria-hidden="true"></span>
            <div class="content">
              <div class="head">
                <span class="kind" style:color={kindColor(n)}>{kindLabel(n)}</span>
                <span class="time">{timeAgo(n.created)}</span>
              </div>
              <div class="body">
                <span class="network">{n.network}</span>{#if n.buffer} <span class="sep">/</span> <span class="buffer">{n.buffer}</span>{/if}
                <span class="title">{n.title}</span>
                <span class="desc">{n.body}</span>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .notification-panel {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .bell {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    cursor: pointer;
    font-size: 1.2em;
  }
  .bell:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
  }
  .bell-icon {
    font-size: 1.4em;
  }
  .badge {
    display: inline-block;
    min-width: 1.4em;
    height: 1.4em;
    padding: 0 4px;
    border-radius: 50%;
    background: var(--danger);
    color: #fff;
    font-size: 0.75em;
    font-weight: 700;
    line-height: 1.4em;
    text-align: center;
  }
  .drawer {
    position: absolute;
    top: 110%;
    right: 0;
    width: min(420px, calc(100vw - 24px));
    max-height: 400px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
    overflow: hidden;
    display: none;
    flex-direction: column;
    z-index: 35;
  }
  .drawer.open {
    display: flex;
  }
  .drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-hover);
  }
  .drawer-header h3 {
    margin: 0;
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    flex: 1;
  }
  .item {
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .item:last-child {
    border-bottom: none;
  }
  .item.unread {
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
  }
  .item .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    margin-top: 8px;
  }
  .item .content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px;
  }
  .item .kind {
    font-size: 0.8em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .item .time {
    font-size: 0.75em;
    color: var(--fg-dim);
  }
  .item .network {
    font-size: 0.85em;
    font-weight: 600;
  }
  .item .sep {
    color: var(--fg-dim);
  }
  .item .buffer {
    font-size: 0.85em;
    color: var(--fg-dim);
  }
  .item .title {
    font-size: 0.9em;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item .desc {
    font-size: 0.8em;
    color: var(--fg-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note {
    margin: 0;
    color: var(--fg-dim);
    font-size: 0.9em;
    padding: 12px;
  }
</style>
