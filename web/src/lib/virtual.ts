// Geometry for a windowed list whose rows have different heights. Only the rows
// near the viewport are rendered, so memory and layout cost stay flat however
// many messages a buffer holds. Heights are estimated until a row has been on
// screen, then measured.

export interface Range {
  /** First row to render. */
  start: number
  /** One past the last row to render. */
  end: number
}

export interface Anchor {
  key: string
  /** How far the viewport top is below the top of that row. */
  delta: number
}

export class Layout {
  private heights = new Map<string, number>()
  private keys: string[] = []
  private index = new Map<string, number>()
  private offs: number[] = [0]
  private dirty = false

  constructor(readonly estimate: number) {}

  get size(): number {
    return this.keys.length
  }

  /** Sets the rows, in order. Heights of rows that are gone are forgotten. */
  setKeys(keys: string[]): void {
    const keep = new Set(keys)
    for (const k of this.heights.keys()) if (!keep.has(k)) this.heights.delete(k)
    this.keys = keys
    this.index = new Map(keys.map((k, i) => [k, i]))
    this.dirty = true
  }

  /** Records a measured height. Returns true when it changed enough to matter. */
  setHeight(key: string, height: number): boolean {
    if (!this.index.has(key) || !(height > 0)) return false
    const old = this.heights.get(key)
    if (old !== undefined && Math.abs(old - height) < 0.5) return false
    this.heights.set(key, height)
    this.dirty = true
    return true
  }

  heightOf(key: string): number {
    return this.heights.get(key) ?? this.estimate
  }

  private offsets(): number[] {
    if (this.dirty) {
      const offs = new Array<number>(this.keys.length + 1)
      let y = 0
      for (let i = 0; i < this.keys.length; i++) {
        offs[i] = y
        y += this.heights.get(this.keys[i]!) ?? this.estimate
      }
      offs[this.keys.length] = y
      this.offs = offs
      this.dirty = false
    }
    return this.offs
  }

  /** Height of everything. */
  get total(): number {
    const o = this.offsets()
    return o[o.length - 1]!
  }

  /** Distance from the top to row i. For i past the end this is the total. */
  offsetOf(i: number): number {
    const o = this.offsets()
    return o[Math.max(0, Math.min(i, o.length - 1))]!
  }

  /** The row that contains vertical position y, clamped to the rows that exist. */
  indexAt(y: number): number {
    const o = this.offsets()
    const n = this.keys.length
    if (n === 0) return 0
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (o[mid]! <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** The rows to render for a viewport, with `overscan` pixels of extra above and below. */
  range(scrollTop: number, viewport: number, overscan: number): Range {
    const n = this.keys.length
    if (n === 0) return { start: 0, end: 0 }
    const top = Math.max(0, scrollTop - overscan)
    const bottom = scrollTop + viewport + overscan
    const start = this.indexAt(top)
    let end = this.indexAt(bottom) + 1
    end = Math.min(n, Math.max(end, start + 1))
    return { start, end }
  }

  /** Remembers which row is at the top of the viewport, to put it back after the layout changes. */
  anchorAt(scrollTop: number): Anchor | null {
    if (this.keys.length === 0) return null
    const i = this.indexAt(scrollTop)
    return { key: this.keys[i]!, delta: scrollTop - this.offsetOf(i) }
  }

  /** Where to scroll so the anchor row is back where it was, or null if that row is gone. */
  scrollTopFor(anchor: Anchor): number | null {
    const i = this.index.get(anchor.key)
    return i === undefined ? null : this.offsetOf(i) + anchor.delta
  }
}
