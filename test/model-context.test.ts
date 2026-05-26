import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getModelContextWindow } from '../src/utils/model-context.js'

describe('getModelContextWindow', () => {
  it('returns Claude Opus 4.6 window for exact match', () => {
    const result = getModelContextWindow('claude-opus-4-6')
    assert.equal(result.contextWindow, 200_000)
    assert.equal(result.outputReserve, 16_000)
    assert.equal(result.effectiveInput, 184_000)
  })

  it('returns Claude Sonnet 4.6 window', () => {
    const result = getModelContextWindow('claude-sonnet-4-6')
    assert.equal(result.contextWindow, 200_000)
    assert.equal(result.outputReserve, 16_000)
    assert.equal(result.effectiveInput, 184_000)
  })

  it('returns Claude 3.5 Sonnet window', () => {
    const result = getModelContextWindow('claude-3-5-sonnet-20241022')
    assert.equal(result.contextWindow, 200_000)
    assert.equal(result.outputReserve, 8_192)
    assert.equal(result.effectiveInput, 200_000 - 8_192)
  })

  it('returns GPT-5 window', () => {
    const result = getModelContextWindow('gpt-5')
    assert.equal(result.contextWindow, 128_000)
    assert.equal(result.outputReserve, 16_000)
  })

  it('returns Gemini 2.5 Pro window with large context', () => {
    const result = getModelContextWindow('gemini-2.5-pro')
    assert.equal(result.contextWindow, 1_048_576)
    assert.equal(result.outputReserve, 16_000)
    assert.equal(result.effectiveInput, 1_048_576 - 16_000)
  })

  it('returns DeepSeek Chat window', () => {
    const result = getModelContextWindow('deepseek-chat')
    assert.equal(result.contextWindow, 128_000)
    assert.equal(result.outputReserve, 4_000)
  })

  it('returns default window for unknown model', () => {
    const result = getModelContextWindow('some-unknown-model-v1')
    assert.equal(result.contextWindow, 128_000)
    assert.equal(result.outputReserve, 8_000)
    assert.equal(result.effectiveInput, 120_000)
  })

  it('is case-insensitive', () => {
    const upper = getModelContextWindow('CLAUDE-OPUS-4-6')
    const lower = getModelContextWindow('claude-opus-4-6')
    assert.deepEqual(upper, lower)
  })

  it('matches partial model names', () => {
    const result = getModelContextWindow('anthropic/claude-3-5-sonnet-latest')
    assert.ok(result.contextWindow > 0)
    assert.equal(result.contextWindow, 200_000)
  })

  it('effectiveInput = contextWindow - outputReserve', () => {
    const models = [
      'claude-opus-4-6',
      'gpt-4o',
      'deepseek-chat',
      'unknown-model',
    ]
    for (const model of models) {
      const result = getModelContextWindow(model)
      assert.equal(result.effectiveInput, result.contextWindow - result.outputReserve)
    }
  })
})
