import { render, screen } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'

import ResetCallout from './ResetCallout.svelte'

describe('ResetCallout', () => {
  it('tells the owner to press RESET and names the board and its button', () => {
    render(ResetCallout, { boardId: 'tdisplay', label: 'LilyGO TTGO T-Display (ESP32)' })
    expect(screen.getByText('Last step: press RESET on the board')).toBeTruthy()
    const body = screen.getByText(/keeps running the old one until it restarts/)
    expect(body.textContent).toMatch(/LilyGO TTGO T-Display \(ESP32\) has the new firmware/)
    expect(body.textContent).toMatch(/side of the board \(not the two front buttons\)/)
    expect(body.textContent).toMatch(/unplug the cable and plug it back in/)
  })

  it('still reads without a known board', () => {
    render(ResetCallout, {})
    expect(screen.getByText(/Your signer has the new firmware/)).toBeTruthy()
  })
})
