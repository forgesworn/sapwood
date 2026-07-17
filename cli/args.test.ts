import { describe, expect, it } from 'vitest'
import { UsageError, intFlag, parseArgs } from './args.js'

describe('parseArgs', () => {
  it('splits positionals from flags', () => {
    const p = parseArgs(['apps', 'revoke', '2', '--identity', '1', '--json'])
    expect(p.positionals).toEqual(['apps', 'revoke', '2'])
    expect(p.flags['identity']).toBe('1')
    expect(p.flags['json']).toBe(true)
  })

  it('accepts --flag=value form', () => {
    const p = parseArgs(['device', '--port=/dev/cu.usbmodem101', '--timeout=4000'])
    expect(p.flags['port']).toBe('/dev/cu.usbmodem101')
    expect(p.flags['timeout']).toBe('4000')
  })

  it('treats -h as help', () => {
    expect(parseArgs(['-h']).flags['help']).toBe(true)
  })

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(UsageError)
  })

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['device', '--port'])).toThrow(UsageError)
    expect(() => parseArgs(['device', '--port', '--json'])).toThrow(UsageError)
  })

  it('rejects a boolean flag given a value', () => {
    expect(() => parseArgs(['--json=yes'])).toThrow(UsageError)
  })
})

describe('intFlag', () => {
  it('parses integers and leaves absent flags undefined', () => {
    expect(intFlag({ timeout: '250' }, 'timeout')).toBe(250)
    expect(intFlag({}, 'timeout')).toBeUndefined()
  })

  it('rejects non-integers and negatives', () => {
    expect(() => intFlag({ timeout: 'soon' }, 'timeout')).toThrow(UsageError)
    expect(() => intFlag({ parent: '-1' }, 'parent')).toThrow(UsageError)
  })
})
