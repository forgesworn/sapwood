import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/svelte'

const { syncMock } = vi.hoisted(() => ({ syncMock: vi.fn() }))
vi.mock('../lib/device.svelte.js', async (orig) => {
  const actual = await orig<typeof import('../lib/device.svelte.js')>()
  return { ...actual, syncIdentityMeta: syncMock }
})

import { device } from '../lib/device.svelte.js'
import IdentityPanel from './IdentityPanel.svelte'

const NPUB = 'npub186c5ke7vjsk98z8qx4ctdrggsl2qlu627g6xvg6yumrj5c5c6etqcfaclx'

beforeEach(() => {
  syncMock.mockReset()
  device.mode = 'serial'
  device.connected = true
  device.masters = [{ slot: 0, label: 'master', mode: 0, modeLabel: 'USB', npub: NPUB }]
})

async function resync() {
  render(IdentityPanel)
  await fireEvent.click(screen.getByRole('button', { name: 'Re-sync profile to signer' }))
}

describe('IdentityPanel identity card sync', () => {
  it('shows a refusal as an alert, not a status', async () => {
    syncMock.mockRejectedValue(new Error('The signer has no room for the picture (its storage is 55% full).'))
    await resync()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no room for the picture')
    expect(alert.className).toContain('error-text')
  })

  it('says which picture went on success, with no alert', async () => {
    syncMock.mockResolvedValue({ name: 'alice', picture: 'small' })
    await resync()
    expect(await screen.findByText(/smaller picture, because the signer's storage is tight/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says so when the initial disc went instead of the picture', async () => {
    syncMock.mockResolvedValue({ name: 'alice', picture: 'placeholder' })
    await resync()
    expect(await screen.findByText(/initial on a disc, because the profile picture was missing or could not be loaded/)).toBeTruthy()
  })

  it('clears an earlier error when a later sync succeeds', async () => {
    syncMock.mockRejectedValueOnce(new Error('refused'))
    await resync()
    await screen.findByRole('alert')
    syncMock.mockResolvedValue({ name: 'alice', picture: 'full' })
    await fireEvent.click(screen.getByRole('button', { name: 'Re-sync profile to signer' }))
    expect(await screen.findByText(/full picture/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
