import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { device, httpTransport } from '../lib/device.svelte.js'
import ApprovalQueue from './ApprovalQueue.svelte'

vi.mock('../lib/device.svelte.js', () => ({
  device: { approvals: [] as Record<string, unknown>[] },
  httpTransport: { resolveApproval: vi.fn() },
}))

const resolveApproval = httpTransport.resolveApproval as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  resolveApproval.mockReset()
  device.approvals = [{ id: 'a1', method: 'sign_event', kind: 1, client_label: 'Test app' }]
})

describe('ApprovalQueue', () => {
  it('shows the reason and keeps the card when deny fails, then allows a retry', async () => {
    resolveApproval.mockResolvedValueOnce({ ok: false, error: 'daemon is locked' })
    render(ApprovalQueue)
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(screen.getByText('Could not deny: daemon is locked')).toBeTruthy())
    expect(screen.getByText('sign_event')).toBeTruthy()
    expect(device.approvals).toHaveLength(1)

    resolveApproval.mockResolvedValueOnce({ ok: true })
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(device.approvals).toHaveLength(0))
    expect(screen.queryByText(/Could not deny/)).toBeNull()
  })

  it('shows the reason and keeps the card when approve fails', async () => {
    resolveApproval.mockResolvedValueOnce({ ok: false, error: 'HTTP 503' })
    render(ApprovalQueue)
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByText('Could not approve: HTTP 503')).toBeTruthy())
    expect(device.approvals).toHaveLength(1)
  })

  it('removes the card when deny succeeds', async () => {
    resolveApproval.mockResolvedValueOnce({ ok: true })
    render(ApprovalQueue)
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(device.approvals).toHaveLength(0))
    expect(resolveApproval).toHaveBeenCalledWith('a1', 'deny')
  })
})
