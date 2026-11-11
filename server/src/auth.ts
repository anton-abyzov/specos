import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, TOKEN_PARAM, type ApiError } from '../../shared/protocol';
import type { Ctx } from './context';

/**
 * Access control. There is one secret, the token printed at start, and one
 * way in: visiting any page with `?token=` once, which trades it for a session
 * cookie. Nothing is public, so a machine on the network that was not given
 * the URL learns nothing, not even that this is SpecOS.
 *
 * The header checks are plain functions because WebSocket upgrades never reach
 * Fastify's hooks; ws.ts applies the same checks to the raw request.
 */

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Compares hashes, so neither the content nor the length of the token leaks through timing. */
export function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  return timingSafeEqual(digest(candidate), digest(token));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of (header ?? '').split(';')) {
    const equals = pair.indexOf('=');
    if (equals === -1 || pair.slice(0, equals).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(equals + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function hasSession(headers: IncomingHttpHeaders, token: string): boolean {
  return tokenMatches(readCookie(headers.cookie, SESSION_COOKIE), token);
}

/**
 * True when the request has no Origin (not sent by a page) or the Origin is
 * this server. SameSite=Strict already keeps the cookie off cross-site
 * requests; this is the second lock, and the only one WebSockets have besides
 * the cookie, since browsers do not apply the same-origin policy to them.
 */
export function originMatchesHost(headers: IncomingHttpHeaders): boolean {
  const { origin, host } = headers;
  if (origin === undefined) return true;
  try {
    return host !== undefined && new URL(origin).host === host.toLowerCase();
  } catch {
    return false; // "null" and anything else that is not a URL
  }
}

function sessionCookie(token: string): string {
  // No Secure attribute: SpecOS is served over plain HTTP on a LAN, and a Secure cookie would never come back.
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

function splitUrl(url: string): { pathname: string; query: URLSearchParams } {
  const mark = url.indexOf('?');
  return mark === -1
    ? { pathname: url, query: new URLSearchParams() }
    : { pathname: url.slice(0, mark), query: new URLSearchParams(url.slice(mark + 1)) };
}

/**
 * The address to land on after the token is accepted: same path, token gone.
 * Leading slashes and backslashes collapse to one slash, because a browser
 * reads "//host" and "/\host" in a Location header as another site.
 */
function cleanLocation(pathname: string, query: URLSearchParams): string {
  const rest = new URLSearchParams(query);
  rest.delete(TOKEN_PARAM);
  const local = '/' + pathname.replace(/^(?:[/\\]|%5c)+/i, '');
  return rest.size > 0 ? `${local}?${rest}` : local;
}

const UNAUTHORIZED_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access needed</title>
<style>
  html { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { max-width: 26rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
</style>
<main>
  <h1>Access needed</h1>
  <p>Open this desktop with the URL printed by the server when it started. It contains the access token.</p>
</main>
</html>
`;

function refuse(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  reply.code(401).header('cache-control', 'no-store');
  if (request.headers.accept?.includes('text/html')) {
    return reply.type('text/html; charset=utf-8').send(UNAUTHORIZED_PAGE);
  }
  return reply.send({ error: 'Access needs the URL printed by the server', code: 'unauthorized' } satisfies ApiError);
}

export function registerAuth(app: FastifyInstance, ctx: Ctx): void {
  const { token } = ctx.config;

  // A root-level onRequest hook runs before routing for every request: API
  // routes, static files and paths that do not exist alike.
  app.addHook('onRequest', async (request, reply) => {
    const { pathname, query } = splitUrl(request.raw.url ?? '/');

    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (pathname === '/api' || pathname.startsWith('/api/')) reply.header('cache-control', 'no-store');

    // Only a GET can trade the token for a session, so the token never rides along on a request that changes state.
    const offered = request.method === 'GET' ? query.get(TOKEN_PARAM) : null;
    if (offered !== null) {
      if (!tokenMatches(offered, token)) return refuse(request, reply);
      return reply
        .header('set-cookie', sessionCookie(token))
        .header('cache-control', 'no-store')
        .redirect(cleanLocation(pathname, query), 302);
    }

    if (!hasSession(request.headers, token)) return refuse(request, reply);

    const changesState = request.method !== 'GET' && request.method !== 'HEAD';
    if (changesState && !originMatchesHost(request.headers)) {
      return reply
        .code(403)
        .send({ error: 'Requests from another origin are not accepted', code: 'foreign_origin' } satisfies ApiError);
    }
  });
}
