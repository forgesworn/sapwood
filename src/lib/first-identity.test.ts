import { describe, it, expect } from 'vitest'
import {
  NAME_MAX, IDENTITY_STEPS, nameError, nameOk, provisionLabel, friendlyLabel, phraseWords,
} from './first-identity.js'

describe('first-identity name validation', () => {
  it('accepts an empty name (naming is optional)', () => {
    expect(nameError('')).toBeNull()
    expect(nameOk('')).toBe(true)
  })

  it('accepts a normal name', () => {
    expect(nameError('My signer')).toBeNull()
    expect(nameOk('My signer')).toBe(true)
  })

  it('accepts a name exactly at the limit', () => {
    expect(nameOk('a'.repeat(NAME_MAX))).toBe(true)
  })

  it('rejects a name over the limit', () => {
    expect(nameOk('a'.repeat(NAME_MAX + 1))).toBe(false)
    expect(nameError('a'.repeat(NAME_MAX + 1))).toMatch(/32/)
  })

  it('ignores surrounding whitespace when measuring length', () => {
    expect(nameOk('  ' + 'a'.repeat(NAME_MAX) + '  ')).toBe(true)
  })
})

describe('provisionLabel', () => {
  it('falls back to "default" for an empty/blank name', () => {
    expect(provisionLabel('')).toBe('default')
    expect(provisionLabel('   ')).toBe('default')
  })

  it('trims and uses a given name', () => {
    expect(provisionLabel('  home rig ')).toBe('home rig')
  })
})

describe('friendlyLabel', () => {
  it('is undefined when unnamed (Home falls back to "Your signer")', () => {
    expect(friendlyLabel('')).toBeUndefined()
    expect(friendlyLabel('  ')).toBeUndefined()
  })

  it('trims and returns a given name', () => {
    expect(friendlyLabel('  Bark ')).toBe('Bark')
  })
})

describe('phraseWords', () => {
  it('splits a phrase into individual words', () => {
    expect(phraseWords('abandon abandon about')).toEqual(['abandon', 'abandon', 'about'])
  })

  it('tolerates extra whitespace and newlines', () => {
    expect(phraseWords('  one\n two   three ')).toEqual(['one', 'two', 'three'])
  })

  it('returns an empty array for a blank phrase', () => {
    expect(phraseWords('   ')).toEqual([])
  })
})

describe('IDENTITY_STEPS', () => {
  it('runs intro → backup → confirm → done', () => {
    expect(IDENTITY_STEPS).toEqual(['intro', 'backup', 'confirm', 'done'])
  })
})
