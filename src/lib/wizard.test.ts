import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  WIZARD_STEPS,
  USER_STEPS,
  initialData,
  parseRelays,
  relayError,
  ssidError,
  passwordError,
  networkError,
  canAdvance,
  nextStep,
  prevStep,
  stepIndex,
  isTerminal,
  friendlyStage,
  DEFAULT_SIGNER_RELAYS,
  cleanRelayList,
  defaultSignerRelays,
  hasOwnDefaultRelays,
  onDefaultRelaysChange,
  setDefaultSignerRelays,
  clearDefaultSignerRelays,
  sameRelayOrder,
  type WizardData,
} from './wizard'

const valid = (o: Partial<WizardData> = {}): WizardData =>
  initialData({ boardId: 'heltec-v4', ssid: 'home-wifi', password: 'hunter2hunter2', ...o })

describe('parseRelays', () => {
  it('splits on commas and newlines, trims, and drops blanks', () => {
    expect(parseRelays('wss://a.cc, wss://b.cc\n  wss://c.cc \n\n')).toEqual([
      'wss://a.cc', 'wss://b.cc', 'wss://c.cc',
    ])
  })
  it('returns an empty array for an empty field', () => {
    expect(parseRelays('   \n , ')).toEqual([])
  })
})

describe('relayError', () => {
  it('requires at least one relay', () => {
    expect(relayError([])).toMatch(/at least one relay/)
  })
  it('rejects a non-relay URL', () => {
    expect(relayError(['https://relay.example'])).toMatch(/wss:\/\//)
  })
  it('accepts ws:// and wss://', () => {
    expect(relayError(['ws://localhost:7777'])).toBeNull()
    expect(relayError(['wss://relay.trotters.cc'])).toBeNull()
  })
})

describe('ssidError', () => {
  it('requires a name', () => {
    expect(ssidError('   ')).toMatch(/name of your Wi-Fi/)
  })
  it('accepts a normal name', () => {
    expect(ssidError('home-wifi')).toBeNull()
  })
  it('rejects names over 32 bytes', () => {
    expect(ssidError('x'.repeat(33))).toMatch(/too long/)
    expect(ssidError('x'.repeat(32))).toBeNull()
  })
})

describe('passwordError', () => {
  it('allows an empty password (open network)', () => {
    expect(passwordError('')).toBeNull()
  })
  it('rejects 1–7 characters', () => {
    expect(passwordError('short')).toMatch(/at least 8/)
  })
  it('accepts 8–63 characters', () => {
    expect(passwordError('12345678')).toBeNull()
    expect(passwordError('x'.repeat(63))).toBeNull()
  })
  it('rejects 64+ characters', () => {
    expect(passwordError('x'.repeat(64))).toMatch(/at most 63/)
  })
})

describe('networkError', () => {
  it('reports the first problem in order: ssid, then password, then relays', () => {
    expect(networkError(valid({ ssid: '' }))).toMatch(/name of your Wi-Fi/)
    expect(networkError(valid({ password: 'bad' }))).toMatch(/at least 8/)
    expect(networkError(valid({ relays: [] }))).toMatch(/at least one relay/)
  })
  it('is null for fully valid data', () => {
    expect(networkError(valid())).toBeNull()
  })
  it('always validates in USB-only mode — no WiFi or relays needed', () => {
    expect(networkError(valid({ netMode: 'usb', ssid: '', password: '', relays: [] }))).toBeNull()
  })
})

describe('canAdvance', () => {
  it('always allows leaving the welcome step', () => {
    expect(canAdvance('welcome', initialData())).toBe(true)
  })
  it('requires a board to leave the board step', () => {
    expect(canAdvance('board', initialData())).toBe(false)
    expect(canAdvance('board', initialData({ boardId: 'heltec-v4' }))).toBe(true)
  })
  it('requires valid network data to leave the network step', () => {
    expect(canAdvance('network', valid({ ssid: '' }))).toBe(false)
    expect(canAdvance('network', valid())).toBe(true)
  })
  it('lets a USB-only signer leave the network step with nothing entered', () => {
    expect(canAdvance('network', valid({ netMode: 'usb', ssid: '', relays: [] }))).toBe(true)
    expect(canAdvance('review', valid({ netMode: 'usb', ssid: '', relays: [] }))).toBe(true)
  })
  it('requires both board and network at review', () => {
    expect(canAdvance('review', valid({ boardId: '' }))).toBe(false)
    expect(canAdvance('review', valid())).toBe(true)
  })
  it('never auto-advances flashing or done', () => {
    expect(canAdvance('flashing', valid())).toBe(false)
    expect(canAdvance('done', valid())).toBe(false)
  })
})

describe('step navigation', () => {
  it('walks the steps in order', () => {
    expect(nextStep('welcome')).toBe('board')
    expect(nextStep('board')).toBe('network')
    expect(nextStep('network')).toBe('review')
    expect(nextStep('review')).toBe('flashing')
    expect(nextStep('flashing')).toBe('done')
  })
  it('clamps at both ends', () => {
    expect(nextStep('done')).toBe('done')
    expect(prevStep('welcome')).toBe('welcome')
  })
  it('prevStep is the inverse within the flow', () => {
    expect(prevStep('review')).toBe('network')
    expect(prevStep('network')).toBe('board')
  })
  it('exposes a stable step order and a user-facing subset', () => {
    expect(WIZARD_STEPS).toEqual(['welcome', 'board', 'network', 'review', 'flashing', 'done'])
    expect(USER_STEPS).toEqual(['welcome', 'board', 'network', 'review'])
    expect(stepIndex('network')).toBe(2)
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('flashing')).toBe(false)
  })
})

describe('friendlyStage', () => {
  it('maps every technical flash stage to plain language', () => {
    expect(friendlyStage('starting')).toBe('Getting ready')
    expect(friendlyStage('erasing flash')).toBe('Wiping the device clean')
    expect(friendlyStage('bootloader')).toBe('Installing the firmware')
    expect(friendlyStage('partition table')).toBe('Installing the firmware')
    expect(friendlyStage('firmware')).toBe('Installing the firmware')
    expect(friendlyStage('config')).toBe('Saving your settings')
    expect(friendlyStage('done')).toBe('All done')
  })
  it('falls back to a neutral line for unknown stages', () => {
    expect(friendlyStage('region 5')).toBe('Working')
  })
  it('never produces an exclamation mark (house voice)', () => {
    for (const s of ['starting', 'erasing flash', 'bootloader', 'config', 'done', 'unknown']) {
      expect(friendlyStage(s)).not.toContain('!')
    }
  })
})

describe('owner default relays', () => {
  const KEY = 'heartwood.defaultSignerRelays'
  afterEach(() => localStorage.clear())

  it('is the built-in set when nothing is stored, as a copy', () => {
    expect(defaultSignerRelays()).toEqual([...DEFAULT_SIGNER_RELAYS])
    expect(hasOwnDefaultRelays()).toBe(false)
    const first = defaultSignerRelays()
    first.push('wss://mutated.example')
    expect(defaultSignerRelays()).toEqual([...DEFAULT_SIGNER_RELAYS])
  })

  it('keeps the order it is given and round-trips', () => {
    const list = ['wss://z.example', 'wss://a.example', 'wss://m.example']
    expect(setDefaultSignerRelays(list)).toEqual(list)
    expect(defaultSignerRelays()).toEqual(list)
    expect(hasOwnDefaultRelays()).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(list)
  })

  it('cleans the list: trims, drops non-strings and non-ws(s) URLs, de-duplicates', () => {
    const stored = setDefaultSignerRelays([
      '  wss://Keep.example/  ',
      'wss://keep.example',
      'WSS://KEEP.EXAMPLE//',
      'https://not-a-relay.example',
      'not a url',
      'wss://',
      'ws://lan.example:7777',
      42 as unknown as string,
      null as unknown as string,
      'wss://other.example',
    ])
    // The first spelling of a duplicate wins.
    expect(stored).toEqual(['wss://Keep.example/', 'ws://lan.example:7777', 'wss://other.example'])
    expect(defaultSignerRelays()).toEqual(stored)
  })

  it('cleanRelayList is pure and keeps order', () => {
    expect(cleanRelayList(['wss://b.example', ' wss://a.example ', 'wss://B.example/'])).toEqual([
      'wss://b.example', 'wss://a.example',
    ])
    expect(cleanRelayList([])).toEqual([])
  })

  it('an empty (or all-invalid) list clears the setting and returns the built-in set', () => {
    setDefaultSignerRelays(['wss://mine.example'])
    expect(setDefaultSignerRelays([])).toEqual([...DEFAULT_SIGNER_RELAYS])
    expect(hasOwnDefaultRelays()).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()

    setDefaultSignerRelays(['wss://mine.example'])
    expect(setDefaultSignerRelays(['junk', 'https://x.example'])).toEqual([...DEFAULT_SIGNER_RELAYS])
    expect(hasOwnDefaultRelays()).toBe(false)
  })

  it('falls back to the built-in set for corrupt, non-array or all-invalid stored values', () => {
    for (const raw of ['{not json', '{"a":1}', '"wss://x.example"', '[]', '[1, null, "https://x.example"]']) {
      localStorage.setItem(KEY, raw)
      expect(defaultSignerRelays(), raw).toEqual([...DEFAULT_SIGNER_RELAYS])
    }
  })

  it('cleans a hand-edited stored list when reading it', () => {
    localStorage.setItem(KEY, JSON.stringify([' wss://a.example ', 7, 'wss://A.example/', 'wss://b.example']))
    expect(defaultSignerRelays()).toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('clear restores the built-in set', () => {
    setDefaultSignerRelays(['wss://mine.example'])
    clearDefaultSignerRelays()
    expect(defaultSignerRelays()).toEqual([...DEFAULT_SIGNER_RELAYS])
    expect(hasOwnDefaultRelays()).toBe(false)
  })

  it('notifies listeners on set and clear, and stops after unsubscribe', () => {
    const fn = vi.fn()
    const off = onDefaultRelaysChange(fn)
    setDefaultSignerRelays(['wss://mine.example'])
    expect(fn).toHaveBeenCalledTimes(1)
    clearDefaultSignerRelays()
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    setDefaultSignerRelays(['wss://mine.example'])
    clearDefaultSignerRelays()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('sameRelayOrder is order-sensitive and exact', () => {
    expect(sameRelayOrder(['wss://a', 'wss://b'], ['wss://a', 'wss://b'])).toBe(true)
    expect(sameRelayOrder(['wss://a', 'wss://b'], ['wss://b', 'wss://a'])).toBe(false)
    expect(sameRelayOrder(['wss://a'], ['wss://a', 'wss://b'])).toBe(false)
    expect(sameRelayOrder(['wss://a'], ['wss://A'])).toBe(false)
    expect(sameRelayOrder([], [])).toBe(true)
  })

  it('initialData().relays uses the stored set', () => {
    expect(initialData().relays).toEqual([...DEFAULT_SIGNER_RELAYS])
    setDefaultSignerRelays(['wss://second.example', 'wss://first.example'])
    expect(initialData().relays).toEqual(['wss://second.example', 'wss://first.example'])
    expect(initialData({ relays: ['wss://override.example'] }).relays).toEqual(['wss://override.example'])
  })
})
