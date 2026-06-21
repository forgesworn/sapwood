import { describe, it, expect } from 'vitest'
import {
  CONNECT_STEPS, nameError, canCreate, stepIndex, nextStep, prevStep,
} from './connect-flow.js'

describe('connect-flow steps', () => {
  it('walks name → permissions → result', () => {
    expect(CONNECT_STEPS).toEqual(['name', 'permissions', 'result'])
  })

  it('nextStep advances and clamps at the end', () => {
    expect(nextStep('name')).toBe('permissions')
    expect(nextStep('permissions')).toBe('result')
    expect(nextStep('result')).toBe('result')
  })

  it('prevStep goes back and clamps at the start', () => {
    expect(prevStep('result')).toBe('permissions')
    expect(prevStep('permissions')).toBe('name')
    expect(prevStep('name')).toBe('name')
  })

  it('stepIndex reflects position', () => {
    expect(stepIndex('name')).toBe(0)
    expect(stepIndex('result')).toBe(2)
  })
})

describe('nameError', () => {
  it('rejects an empty or whitespace name', () => {
    expect(nameError('')).not.toBeNull()
    expect(nameError('   ')).not.toBeNull()
  })

  it('accepts a normal name', () => {
    expect(nameError('Damus on my phone')).toBeNull()
  })

  it('rejects an over-long name', () => {
    expect(nameError('x'.repeat(49))).not.toBeNull()
    expect(nameError('x'.repeat(48))).toBeNull()
  })

  it('error messages avoid exclamation marks (house voice)', () => {
    expect(nameError('')).not.toContain('!')
  })
})

describe('canCreate', () => {
  it('mirrors nameError', () => {
    expect(canCreate('')).toBe(false)
    expect(canCreate('bark-laptop')).toBe(true)
  })
})
