// Meta API prices, from dev.meta.ai/docs/pricing-rate-limits (read Oct 27).
// The proxy uses them to hold the daily spend cap, and scripts/live/ to
// show what a run will cost before asking. One table, so they can't disagree.

export const SAM_MODEL = 'sam-3.1';
export const WONDER_MODEL = 'muse-wonder-1.0';

// SAM 3.1 video: $0.20 per 1,000 frames, and every request bills at least 50.
export const SAM_USD_PER_FRAME = 0.2 / 1000;
export const SAM_MIN_FRAMES = 50;

// Muse Wonder, per token: $4.00 / 1M input, $0.20 / 1M cached input, $20.00 / 1M
// output (reasoning tokens bill as output).
export const WONDER_USD_PER_INPUT_TOKEN = 4 / 1e6;
export const WONDER_USD_PER_CACHED_TOKEN = 0.2 / 1e6;
export const WONDER_USD_PER_OUTPUT_TOKEN = 20 / 1e6;

// The image docs say a ~1280 px image is about 1,300–1,500 tokens. Images
// are sent no larger than that, so the top of that range bounds each one.
export const IMAGE_TOKENS_MAX = 1500;

// The app caps clips at 15 s of 30 fps, so no SAM call covers more frames.
export const MAX_CLIP_FRAMES = 15 * 30;

export function samCost(frames: number): number {
  return Math.max(frames, SAM_MIN_FRAMES) * SAM_USD_PER_FRAME;
}

export interface WonderUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
}

export function wonderCost(usage: WonderUsage): number {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return (
    (usage.input_tokens - cached) * WONDER_USD_PER_INPUT_TOKEN +
    cached * WONDER_USD_PER_CACHED_TOKEN +
    usage.output_tokens * WONDER_USD_PER_OUTPUT_TOKEN
  );
}

// The most one Wonder call can cost: every image at the token ceiling, text
// at one token per 3 characters (real text runs nearer 4), and the full
// output allowance spent.
export function wonderMaxCost(images: number, textChars: number, maxOutputTokens: number): number {
  const input = images * IMAGE_TOKENS_MAX + Math.ceil(textChars / 3);
  return input * WONDER_USD_PER_INPUT_TOKEN + maxOutputTokens * WONDER_USD_PER_OUTPUT_TOKEN;
}
