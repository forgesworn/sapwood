import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import ClientConsent from './ClientConsent.svelte'
import type { ConnectSlot } from '../lib/types.js'
const client = 'aa'.repeat(32), id = 'bb'.repeat(32), tag = 'cc'.repeat(8)
const slot: ConnectSlot = { slot_index: 0, label: 'Shared', secret: '', current_pubkey: client,
  allowed_methods: [], allowed_kinds: [], auto_approve: true, signing_approved: true,
  client_approvals: [{ client_pubkey: client, approved_identities: [id], legacy_identity_tags: [tag] }] }
const props = () => ({ slot, canRevoke: true, identityLabel: (key: string) => key === id ? 'Personal' : 'Inherited', onrevoke: vi.fn(async () => {}) })
async function open() {
  await fireEvent.click(screen.getByText('Persona consent'))
  await fireEvent.click(screen.getByText('aaaaaaaa…aaaaaaaa'))
}
describe('per-device consent controls', () => {
  it('renders nothing for unknown legacy scope', () => {
    const { container } = render(ClientConsent, { ...props(), slot: { ...slot, client_approvals: undefined } })
    expect(container.textContent?.trim()).toBe('')
  })
  it('confirms one inherited tag for precisely one device', async () => {
    const p = props(); render(ClientConsent, p); await open()
    await fireEvent.click(screen.getAllByText('Withdraw identity')[1]!)
    expect(p.onrevoke).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByText('Yes, withdraw identity'))
    await waitFor(() => expect(p.onrevoke).toHaveBeenCalledWith(client, tag))
    expect(screen.getByText('Consent withdrawn.')).toBeTruthy()
  })
  it('keeps pairing-wide withdrawal distinct and shows failures', async () => {
    const p = props(); p.onrevoke.mockRejectedValueOnce(new Error('Storage unavailable'))
    render(ClientConsent, p); await open()
    await fireEvent.click(screen.getByText('Withdraw all consent'))
    await fireEvent.click(screen.getByText('Yes, withdraw all consent'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Storage unavailable'))
    expect(p.onrevoke).toHaveBeenCalledWith(undefined, undefined)
    expect(screen.queryByText('Consent withdrawn.')).toBeNull()
  })
  it('does not offer write controls without management access', async () => {
    render(ClientConsent, { ...props(), canRevoke: false }); await open()
    expect(screen.queryByText('Withdraw identity')).toBeNull()
    expect(screen.getByText('Connect with management access to withdraw consent.')).toBeTruthy()
  })
})
