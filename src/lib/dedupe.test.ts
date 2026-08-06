import { describe, expect, it } from 'vitest'
import { dedupeBy } from './dedupe.js'

describe('dedupeBy', () => {
  it('keeps the first item for each key, in order', () => {
    const items = [
      { id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'a', n: 3 }, { id: 'c', n: 4 },
    ]
    expect(dedupeBy(items, (i) => i.id)).toEqual([
      { id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 4 },
    ])
  })

  it('leaves a list without repeats untouched', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    expect(dedupeBy(items, (i) => i.id)).toEqual(items)
  })

  it('handles the empty list', () => {
    expect(dedupeBy([], () => '')).toEqual([])
  })
})
