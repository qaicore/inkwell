// The Wonder plan call as the proxy forwards it (SPEC §9): the drawing frame
// with each stroke in its own color and numbered at its root, plus the
// prompt, with the plan schema as the structured output format. The proxy
// pins reasoning to 'low' and caps the output tokens; the page can't raise
// either.
import { WONDER_MODEL } from '../../functions/_lib/pricing.ts';
import type { PlanRequest, PlanTransport } from './plan.ts';

export const PLAN_OUTPUT_TOKENS = 4000;

export function planBody(request: PlanRequest, frameImage: string): Record<string, unknown> {
  return {
    model: WONDER_MODEL,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.prompt }, { type: 'input_image', image_url: frameImage }] }],
    text: { format: { type: 'json_schema', name: 'stroke_plan', schema: request.schema, strict: true } },
    max_output_tokens: PLAN_OUTPUT_TOKENS,
  };
}

// The text Wonder answered with, from a Responses API reply.
export function outputText(reply: unknown): string {
  const r = reply as { output_text?: unknown; output?: { content?: { type?: string; text?: string }[] }[] } | null;
  if (typeof r?.output_text === 'string') return r.output_text;
  return (r?.output ?? []).flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text ?? '').join('');
}

// Through the proxy. `frameImage` draws the numbered frame as a data URL.
export function proxyTransport(frameImage: (request: PlanRequest) => string): PlanTransport {
  return async (request) => {
    const response = await fetch('/api/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(planBody(request, frameImage(request))),
    });
    if (!response.ok) throw new Error(`the proxy answered ${response.status}`);
    return outputText(await response.json());
  };
}
