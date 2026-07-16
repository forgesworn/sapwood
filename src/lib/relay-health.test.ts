import { describe, expect, it } from 'vitest'
import { classifyRelayHealth } from './relay-health.js'

describe('classifyRelayHealth', () => {
  it('marks a failure or no-answer red', () => {
    expect(classifyRelayHealth(null, true)).toEqual({ health: 'red', note: 'unreachable' })
    expect(classifyRelayHealth(null, false)).toEqual({ health: 'red', note: 'unreachable' })
    expect(classifyRelayHealth(1234, true)).toEqual({ health: 'red', note: 'unreachable' })
  })

  it('marks a prompt answer green', () => {
    expect(classifyRelayHealth(120, false)).toEqual({ health: 'green' })
    expect(classifyRelayHealth(799, false)).toEqual({ health: 'green' })
  })

  it('marks a slow answer amber', () => {
    expect(classifyRelayHealth(800, false)).toEqual({ health: 'amber', note: 'slow' })
    expect(classifyRelayHealth(3999, false)).toEqual({ health: 'amber', note: 'slow' })
  })

  it('marks a very slow answer red', () => {
    expect(classifyRelayHealth(4000, false)).toEqual({ health: 'red', note: 'very slow' })
    expect(classifyRelayHealth(9000, false)).toEqual({ health: 'red', note: 'very slow' })
  })
})
