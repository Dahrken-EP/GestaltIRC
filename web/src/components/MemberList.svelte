<script lang="ts">
  import { nickColor } from '../lib/nickcolor'
  import type { Buffer, NetworkState } from '../lib/network.svelte'
  import { settings } from '../lib/settings.svelte'

  let { net, buf, onnick }: { net: NetworkState; buf: Buffer; onnick: (nick: string) => void } = $props()

  // Highest prefix first, then alphabetical.
  const rank = (prefix: string) => {
    const i = prefix ? net.prefixSymbols.indexOf(prefix[0]!) : -1
    return i < 0 ? 99 : i
  }
  const sorted = $derived.by(() => {
    void buf.membersRev
    return [...buf.members.values()].sort(
      (a, b) => rank(a.prefix) - rank(b.prefix) || a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }),
    )
  })
</script>

<aside class="members" aria-label="Members of {buf.name}">
  <h3>{sorted.length} {sorted.length === 1 ? 'member' : 'members'}</h3>
  <ul>
    {#each sorted as m (m.nick)}
      <li>
        <button class:away={m.away} onclick={() => onnick(m.nick)} title={m.away ? `${m.nick} (away)` : m.nick}>
          <span class="prefix">{m.prefix[0] ?? ''}</span><span class="n" style:color={nickColor(m.nick, settings.nickColors)}>{m.nick}</span>
        </button>
      </li>
    {/each}
  </ul>
</aside>

<style>
  .members {
    width: 180px;
    height: 100%;
    overflow-y: auto;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
  }
  h3 {
    margin: 0;
    padding: 8px 10px;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-dim);
    position: sticky;
    top: 0;
    background: var(--bg-panel);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 4px 8px;
  }
  button {
    display: flex;
    width: 100%;
    padding: 0 6px;
    border-radius: 4px;
    text-align: left;
    white-space: nowrap;
  }
  button:hover {
    background: var(--bg-hover);
  }
  button.away {
    opacity: 0.5;
  }
  .prefix {
    width: 1.1em;
    flex: none;
    color: var(--fg-dim);
    font-weight: 700;
  }
  .n {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
