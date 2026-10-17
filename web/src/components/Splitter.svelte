<script lang="ts">
  // A bar between two columns. Drag it, or focus it and use the arrow keys; double-click puts it back.
  let { value, min, max, grows = 1, label, onchange, onreset }: {
    value: number
    min: number
    max: number
    /** 1 when dragging right makes the column on the left wider, -1 when it makes the column on the right wider. */
    grows?: 1 | -1
    label: string
    onchange: (v: number) => void
    onreset: () => void
  } = $props()

  let dragging = $state(false)
  let startX = 0
  let startValue = 0

  function down(e: PointerEvent) {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragging = true
    startX = e.clientX
    startValue = value
    e.preventDefault()
  }

  function move(e: PointerEvent) {
    if (dragging) onchange(startValue + (e.clientX - startX) * grows)
  }

  function up() {
    dragging = false
  }

  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') onchange(value - step * grows)
    else if (e.key === 'ArrowRight') onchange(value + step * grows)
    else if (e.key === 'Home') onchange(min)
    else if (e.key === 'End') onchange(max)
    else return
    e.preventDefault()
  }
</script>

<!-- A separator that can be focused and moved is a widget, so it takes keys and pointers. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="splitter"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  title="Drag to resize, double-click to reset"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={onreset}
  onkeydown={key}
></div>

<style>
  .splitter {
    width: 5px;
    flex: none;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    position: relative;
    z-index: 2;
  }
  .splitter:hover,
  .splitter:focus-visible,
  .splitter.dragging {
    background: var(--accent);
    opacity: 0.6;
  }
  .splitter.dragging {
    opacity: 0.9;
  }
  @media (max-width: 720px) {
    .splitter {
      display: none;
    }
  }
</style>
