import { describe, it, expect } from 'vitest'
import { parseRoute } from './route.svelte'

describe('parseRoute', () => {
  it('routes the flash hash to the flasher', () => {
    expect(parseRoute('#/flash')).toBe('flash')
    expect(parseRoute('#flash')).toBe('flash')
    expect(parseRoute('#/Flash')).toBe('flash')
  })
  it('routes everything else to admin', () => {
    expect(parseRoute('')).toBe('admin')
    expect(parseRoute('#/')).toBe('admin')
    expect(parseRoute('#/clients')).toBe('admin')
    expect(parseRoute('#/settings')).toBe('admin')
  })
})
