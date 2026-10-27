// Cloudflare Pages Function for /api/*: the app's only way to the Meta API.
// The logic is in ../_lib/proxy.ts; this file only wires in the real API host
// and fetch. Secrets come from .dev.vars locally and Cloudflare secrets when
// deployed; SPEND is a KV namespace bound to the project.
import { handleProxy, type ProxyEnv } from '../_lib/proxy.ts';

const UPSTREAM = 'https://api.meta.ai/v1';

interface PagesContext {
  request: Request;
  env: ProxyEnv;
  params: { path?: string | string[] };
}

export const onRequest = (context: PagesContext): Promise<Response> =>
  handleProxy(context.request, [context.params.path ?? []].flat().join('/'), context.env, {
    upstream: UPSTREAM,
    fetch: (request) => fetch(request),
  });
