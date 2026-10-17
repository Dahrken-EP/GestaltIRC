<script lang="ts" generics="T extends { key: string }">
  // A scrolling list that renders only the rows near the viewport. Row heights
  // vary, so each row is measured once it has been on screen. The view stays put
  // when rows above it change height or older rows are added, and it follows the
  // bottom while the user is there.
  import { onMount, untrack, type Snippet } from 'svelte'
  import { Layout, type Anchor } from '../lib/virtual'

  let {
    items,
    children,
    estimate = 24,
    overscan = 600,
    onreachtop,
    label = '',
    atBottom = $bindable(true),
  }: {
    items: T[]
    children: Snippet<[T]>
    estimate?: number
    overscan?: number
    onreachtop?: () => void
    label?: string
    /** True while the view is at the bottom. */
    atBottom?: boolean
  } = $props()

  let el: HTMLDivElement
  const layout = new Layout(untrack(() => estimate))
  let rev = $state(0)
  let scrollTop = $state(0)
  let viewport = $state(0)
  /** True while the view is at the bottom, so new rows keep it there. */
  let stick = true
  /** Which row was at the top before the layout changed, to put it back afterwards. */
  let pending: Anchor | null = null

  const range = $derived.by(() => {
    void rev
    return layout.range(scrollTop, viewport, overscan)
  })
  const visible = $derived(items.slice(range.start, range.end))
  const padTop = $derived.by(() => (void rev, layout.offsetOf(range.start)))
  const padBottom = $derived.by(() => (void rev, layout.total - layout.offsetOf(range.end)))

  // Keep the layout's row list in step with `items`.
  $effect.pre(() => {
    const keys = items.map((i) => i.key)
    untrack(() => {
      pending = stick || !el ? null : layout.anchorAt(el.scrollTop)
      layout.setKeys(keys)
      rev++
    })
  })

  // After the DOM has updated: follow the bottom, or restore the row the user was reading.
  $effect(() => {
    void rev
    void items
    if (!el) return
    untrack(() => {
      if (stick) {
        el.scrollTop = el.scrollHeight
      } else if (pending) {
        const t = layout.scrollTopFor(pending)
        if (t !== null) el.scrollTop = t
      }
      pending = null
      scrollTop = el.scrollTop
    })
  })

  function onscroll() {
    if (!el) return
    scrollTop = el.scrollTop
    stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    atBottom = stick
    if (el.scrollTop < 120) onreachtop?.()
  }

  /** Scrolls to the newest row and follows it from here on. */
  export function toBottom() {
    stick = true
    atBottom = true
    el.scrollTop = el.scrollHeight
  }

  const nodes = new Set<HTMLElement>()
  let rowObserver: ResizeObserver | undefined

  function measure(node: HTMLElement, key: string) {
    node.dataset.key = key
    nodes.add(node)
    rowObserver?.observe(node)
    return {
      update(next: string) {
        node.dataset.key = next
      },
      destroy() {
        nodes.delete(node)
        rowObserver?.unobserve(node)
      },
    }
  }

  onMount(() => {
    viewport = el.clientHeight
    rowObserver = new ResizeObserver((entries) => {
      if (!el) return // the list went away while this was queued
      // Take the anchor from the layout as it was, before this batch of heights is applied.
      const anchor = stick ? null : layout.anchorAt(el.scrollTop)
      let changed = false
      for (const e of entries) {
        const node = e.target as HTMLElement
        const key = node.dataset.key
        const h = e.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight
        if (key && layout.setHeight(key, h)) changed = true
      }
      if (changed) {
        pending ??= anchor
        rev++
      }
    })
    for (const n of nodes) rowObserver.observe(n)

    const boxObserver = new ResizeObserver(() => {
      if (!el) return
      viewport = el.clientHeight
      if (stick) el.scrollTop = el.scrollHeight
    })
    boxObserver.observe(el)
    el.scrollTop = el.scrollHeight
    return () => {
      rowObserver?.disconnect()
      boxObserver.disconnect()
    }
  })
</script>

<div class="vl" bind:this={el} {onscroll} role="log" aria-live="polite" aria-relevant="additions" aria-label={label}>
  <div style:padding-top="{padTop}px" style:padding-bottom="{padBottom}px">
    {#each visible as item (item.key)}
      <div class="row" use:measure={item.key}>{@render children(item)}</div>
    {/each}
  </div>
</div>

<style>
  .vl {
    height: 100%;
    overflow-y: auto;
    /* The list keeps its own scroll position; the browser's anchoring would fight it. */
    overflow-anchor: none;
  }
</style>
