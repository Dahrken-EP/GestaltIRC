// Matching what someone typed against names, for the quick switcher. A query matches when
// its letters appear in the text in order; the score prefers matches that start the text or
// a word and that run together, so "gen" finds #general before #engineering.

/** How well `query` matches `text`, higher being better, or null when it does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let at = 0
  let run = 0
  for (const ch of q) {
    const found = t.indexOf(ch, at)
    if (found < 0) return null
    const atWordStart = found === 0 || /[^a-z0-9]/.test(t[found - 1]!)
    if (found === at && run > 0) {
      run++
      score += 3 + run
    } else {
      run = 1
      score += atWordStart ? 6 : 1
    }
    if (found === 0) score += 4
    at = found + 1
  }
  // A shorter name that fits the query is a better match than a long one that merely contains it.
  return score - Math.min(t.length - q.length, 20) * 0.1
}

/** The items that match, best first. Items that score alike keep their given order. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string[]): T[] {
  if (!query.trim()) return items
  const scored: { item: T; score: number; i: number }[] = []
  items.forEach((item, i) => {
    let best: number | null = null
    for (const field of text(item)) {
      const s = fuzzyScore(query, field)
      if (s !== null && (best === null || s > best)) best = s
    }
    if (best !== null) scored.push({ item, score: best, i })
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.map((s) => s.item)
}
