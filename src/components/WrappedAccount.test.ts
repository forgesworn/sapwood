import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/svelte'
import { nip19 } from 'nostr-tools'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../lib/device.svelte.js', async orig => ({ ...await orig<typeof import('../lib/device.svelte.js')>(), serialWrappedAccount: request }))
import { device } from '../lib/device.svelte.js'
import WrappedAccount from './WrappedAccount.svelte'
const a = nip19.npubEncode('11'.repeat(32))
const b = nip19.npubEncode('22'.repeat(32))
const record = 'nstw1:' + 'A'.repeat(175)
beforeEach(() => {
  request.mockReset()
  device.mode = 'serial'; device.connected = true
  device.masters = [{ slot: 0, label: 'root', mode: 1, modeLabel: 'TREE', npub: a }]
})
it('keeps restore disabled until the saved file has been checked for the selected root and exact npub', async () => {
  render(WrappedAccount)
  const restore = screen.getByRole('button', { name: /Restore into empty slot/ })
  expect(restore.hasAttribute('disabled')).toBe(true)
  await fireEvent.change(screen.getByLabelText('Recovery root'), { target: { value: '0' } })
  await fireEvent.input(screen.getByLabelText('Expected account npub'), { target: { value: b } })
  const file = new File([record], 'account.nstw')
  Object.defineProperty(file, 'text', { value: async () => record })
  await fireEvent.change(screen.getByLabelText('Saved encrypted file'), { target: { files: [file] } })
  request.mockResolvedValue({ op: 'check', npub: b })
  await fireEvent.click(screen.getByRole('button', { name: 'Check saved file on signer' }))
  await screen.findByText(/Saved file checked/)
  await fireEvent.input(screen.getByLabelText('Restored account name'), { target: { value: 'existing' } })
  expect(restore.hasAttribute('disabled')).toBe(false)
  await fireEvent.input(screen.getByLabelText('Expected account npub'), { target: { value: a } })
  expect(restore.hasAttribute('disabled')).toBe(true)
  expect(request).toHaveBeenCalledOnce()
})
it('refuses oversized input before a device operation and explains the two-part recovery', async () => {
  render(WrappedAccount)
  expect(screen.getByText(/same root.*encrypted file/)).toBeTruthy()
  await fireEvent.change(screen.getByLabelText('Saved encrypted file'), { target: { files: [new File(['x'.repeat(182)], 'large.nstw')] } })
  expect((await screen.findByRole('alert')).textContent).toMatch(/181-byte/)
  expect(request).not.toHaveBeenCalled()
})

it('checks the latest selected file when an earlier file read finishes last', async () => {
  render(WrappedAccount)
  await fireEvent.change(screen.getByLabelText('Recovery root'), { target: { value: '0' } })
  await fireEvent.input(screen.getByLabelText('Expected account npub'), { target: { value: b } })
  let finishOldRead!: (value: string) => void
  const old = new File([record], 'old.nstw')
  Object.defineProperty(old, 'text', { value: () => new Promise<string>(resolve => { finishOldRead = resolve }) })
  const latestRecord = 'nstw1:' + 'B'.repeat(175)
  const latest = new File([latestRecord], 'latest.nstw')
  Object.defineProperty(latest, 'text', { value: async () => latestRecord })
  const input = screen.getByLabelText('Saved encrypted file')
  await fireEvent.change(input, { target: { files: [old] } })
  await fireEvent.change(input, { target: { files: [latest] } })
  await act(() => finishOldRead(record))
  request.mockResolvedValue({ op: 'check', npub: b })
  await fireEvent.click(screen.getByRole('button', { name: 'Check saved file on signer' }))
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: 'check', record: latestRecord }))
})

it('does not revive a previous file after the latest selection is rejected', async () => {
  render(WrappedAccount)
  await fireEvent.change(screen.getByLabelText('Recovery root'), { target: { value: '0' } })
  await fireEvent.input(screen.getByLabelText('Expected account npub'), { target: { value: b } })
  let finishOldRead!: (value: string) => void
  const old = new File([record], 'old.nstw')
  Object.defineProperty(old, 'text', { value: () => new Promise<string>(resolve => { finishOldRead = resolve }) })
  const input = screen.getByLabelText('Saved encrypted file')
  await fireEvent.change(input, { target: { files: [old] } })
  await fireEvent.change(input, { target: { files: [new File(['bad'], 'bad.nstw')] } })
  await act(() => finishOldRead(record))
  expect(screen.getByRole('button', { name: 'Check saved file on signer' }).hasAttribute('disabled')).toBe(true)
  expect(request).not.toHaveBeenCalled()
})
