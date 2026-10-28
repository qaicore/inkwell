// Cloudflare Pages Function for /api/*: the app's only way to the Meta API.
// The logic is in ../_lib/proxy.ts; this file only wires in the real API host,
// fetch and spend store. Secrets come from .dev.vars locally and Cloudflare
// secrets when deployed; SPEND_DB is a D1 database bound to the project, and
// the store makes its one table on first use.
import { handleProxy, type ProxyEnv } from '../_lib/proxy.ts';
import { d1SpendStore, type D1Like } from '../_lib/spend.ts';

const UPSTREAM = 'https://api.meta.ai/v1';

interface PagesContext {
  request: Request;
  env: Omit<ProxyEnv, 'SPEND'> & { SPEND_DB?: D1Like; ASSETS?: { fetch(request: Request): Promise<Response> } };
  params: { path?: string | string[] };
}

export const onRequest = ({ request, env, params }: PagesContext): Promise<Response> =>
  handleProxy(request, [params.path ?? []].flat().join('/'), { ...env, SPEND: env.SPEND_DB && d1SpendStore(env.SPEND_DB) }, {
    upstream: UPSTREAM,
    fetch: (request) => fetch(request),
    // Cached answers ship as static files under /cache/<clip sha256>/ (M4: the live link's samples).
    cache: async (sha, file) => (env.ASSETS ? env.ASSETS.fetch(new Request(new URL(`/cache/${sha}/${file}`, request.url))) : null),
  });
