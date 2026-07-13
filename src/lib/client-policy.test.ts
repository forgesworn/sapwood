import { describe, expect, it } from 'vitest'
import { exactClientPolicy, exactPolicyFromSlot, fullClientPolicy, policiesEqual } from './client-policy.js'

describe('exact client policy', () => {
  it('never emits an empty method list and clears orphan event kinds', () => {
    expect(exactClientPolicy([], [1])).toEqual({
      allowed_methods: ['get_public_key'],
      allowed_kinds: [],
      auto_approve: true,
    })
  })

  it('canonicalises signing kinds and drops unsupported methods', () => {
    expect(exactClientPolicy(['sign_event', 'bad_method'], [7, 1, 7])).toEqual({
      allowed_methods: ['get_public_key', 'sign_event'],
      allowed_kinds: [1, 7],
      auto_approve: true,
    })
  })

  it('preserves a slot without inferring signing from kinds', () => {
    expect(exactPolicyFromSlot({
      slot_index: 2,
      label: 'app',
      secret: '',
      current_pubkey: null,
      allowed_methods: ['get_public_key', 'sign_event'],
      allowed_kinds: [1],
      auto_approve: false,
      signing_approved: false,
    })).toEqual({
      allowed_methods: ['get_public_key'],
      allowed_kinds: [],
      auto_approve: false,
    })
  })

  it('compares echoed policies setwise', () => {
    const expected = fullClientPolicy()
    expect(policiesEqual(expected, {
      allowed_methods: [...expected.allowed_methods].reverse(),
      allowed_kinds: [],
      auto_approve: true,
    })).toBe(true)
    expect(policiesEqual(expected, {
      allowed_methods: ['get_public_key'],
      allowed_kinds: [],
      auto_approve: true,
    })).toBe(false)
  })
})
