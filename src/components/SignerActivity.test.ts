import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import SignerActivity from './SignerActivity.svelte'
import { device } from '../lib/device.svelte.js'

vi.mock('../lib/device.svelte.js', () => ({
  device: {
    connected: true,
    signerActivity: [],
  },
}))

beforeEach(() => {
  device.connected = true
  device.signerActivity = []
})

describe('SignerActivity', () => {
  it('shows an empty connected state', () => {
    render(SignerActivity)
    expect(screen.getByText('Signer Activity')).toBeTruthy()
    expect(screen.getByText('No signing activity yet.')).toBeTruthy()
  })

  it('renders newest activity first with app, kind, client and source', () => {
    device.signerActivity = [
      {
        id: 'old',
        at: '2026-07-07T10:00:00.000Z',
        source: 'relay-audit',
        method: 'sign_event',
        outcome: 'signed',
        action: 'signed',
        app: 'Primal',
        client: 'aaaaaaaa',
        kind: 0,
        kindText: 'Profile (kind 0)',
        preview: '{"name":"alice"}',
      },
      {
        id: 'new',
        at: '2026-07-07T10:01:00.000Z',
        source: 'relay-audit',
        method: 'nip04_decrypt',
        outcome: 'ok',
        action: 'nip04_decrypt ok',
        app: 'Primal',
        client: 'bbbbbbbb',
        kind: null,
        kindText: '',
        preview: 'peer 12345678 - content redacted',
      },
    ]

    const { container } = render(SignerActivity)
    const rows = [...container.querySelectorAll('.activity-row')]

    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('nip04_decrypt')
    expect(rows[0]?.textContent).toContain('client bbbbbbbb')
    expect(rows[0]?.textContent).toContain('relay audit')
    expect(rows[1]?.textContent).toContain('Profile (kind 0)')
    expect(screen.getByText('2 events')).toBeTruthy()
  })

  it('marks failed activity', () => {
    device.signerActivity = [{
      id: 'failed',
      at: '2026-07-07T10:00:00.000Z',
      source: 'relay-audit',
      method: 'sign_event',
      outcome: 'error: unauthorised',
      action: 'sign_event failed (unauthorised)',
      app: 'unknown app',
      client: 'cccccccc',
      kind: 999999,
      kindText: 'unknown Nostr kind 999999',
      preview: '{"custom":true}',
    }]

    const { container } = render(SignerActivity)
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(container.querySelector('.activity-row--bad')).toBeTruthy()
  })
})
