/**
 * UFUQ public edge — the fixed https://<name>.<subdomain>.workers.dev URL.
 *
 * Forwards every request to the Render web service (ORIGIN) and makes the
 * response look like it came from this host:
 *  - X-Forwarded-For is set to the real client (CF-Connecting-IP), so the
 *    API's per-client login rate limits keep working (TRUST_PROXY_HOPS);
 *  - redirect Locations pointing at the origin host are rewritten to this host.
 * Cookies carry no Domain attribute, so the browser scopes them to this host.
 */
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const origin = new URL(env.ORIGIN);
    const target = new URL(incoming.pathname + incoming.search, origin);

    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') ?? '');
    headers.set('X-Forwarded-Host', incoming.host);
    headers.delete('X-Forwarded-Proto');

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });

    const location = response.headers.get('Location');
    if (!location) return response;
    const rewritten = new Response(response.body, response);
    const next = new URL(location, origin);
    if (next.host === origin.host) {
      next.protocol = incoming.protocol;
      next.host = incoming.host;
      rewritten.headers.set('Location', next.toString());
    }
    return rewritten;
  },
};
