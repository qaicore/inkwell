import { describe, expect, it } from 'vitest';
import { MAX_CLIP_FRAMES, samCost, wonderCost, wonderMaxCost } from '../../functions/_lib/pricing.ts';

describe('pricing', () => {
  it('bills SAM video per frame with a 50-frame minimum', () => {
    expect(samCost(300)).toBeCloseTo(0.06, 9);
    expect(samCost(10)).toBeCloseTo(0.01, 9);
    expect(samCost(MAX_CLIP_FRAMES)).toBeCloseTo(0.09, 9);
  });

  it('bills Wonder tokens, with cached input at the cached rate', () => {
    expect(wonderCost({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(4, 9);
    expect(wonderCost({ input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cached_tokens: 1_000_000 } })).toBeCloseTo(0.2, 9);
    expect(wonderCost({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(20, 9);
  });

  it('bounds a Wonder call from its images, text and output allowance', () => {
    // 8 images at 1,500 tokens + 300 chars at 3 per token, then 4,000 output tokens.
    expect(wonderMaxCost(8, 300, 4000)).toBeCloseTo(12_100 * 4e-6 + 4000 * 20e-6, 9);
  });
});
