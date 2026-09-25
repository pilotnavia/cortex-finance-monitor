import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';

let ratelimit = null;

function getRatelimit() {
  if (ratelimit) return ratelimit;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(600, '60 s'),
    prefix: 'rl',
    analytics: false,
  });

  return ratelimit;
}

// Sentinel returned when no trusted client-IP header is present. Routed
// through the Upstash limiter as a single shared bucket so the entire
// "no trusted identity" population is naturally rate-limited together —
// an attacker who strips cf-connecting-ip / x-real-ip can no longer rotate
// identities by toggling x-forwarded-for. (#3531) Mirrors the constant in
// server/_shared/rate-limit.ts.
export const UNKNOWN_CLIENT_IP = 'unknown';

// Marker headers set on every degraded (fail-closed) response so observability
// can correlate "rate-limit unavailable" windows with downstream behaviour
// without parsing the JSON body. Mirrors RATE_LIMIT_DEGRADED_HEADERS in
// server/_shared/rate-limit.ts.
export const RATE_LIMIT_DEGRADED_HEADERS = Object.freeze({
  'X-RateLimit-Mode': 'degraded',
  'Retry-After': '5',
});

// Sync constant-time string compare (edge: Web Crypto's timingSafeEqual is async
// and getClientIp is a sync hot path). Length-guarded XOR fold leaks only the
// length, not the content, of a high-entropy secret. Mirrors constantTimeEqual in
// server/_shared/rate-limit.ts.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Whether cf-connecting-ip can be trusted. With no ingress secret configured we
// trust it as before (dormant — zero behaviour change). Once WM_CF_INGRESS_SECRET
// is set, a Cloudflare Transform Rule must inject a matching x-wm-cf-ingress
// header; a request without it reached the origin without transiting Cloudflare
// (e.g. the raw *.vercel.app alias) and must not set its rate-limit identity via
// a forged cf-connecting-ip. Add the CF Transform Rule FIRST, then set the env
// var. Mirrors cfIngressTrusted in server/_shared/rate-limit.ts.
export function cfIngressTrusted(request) {
  const secret = process.env.WM_CF_INGRESS_SECRET;
  if (!secret) return true;
  const provided = (request.headers.get('x-wm-cf-ingress') ?? '').trim();
  return provided.length > 0 && constantTimeEqual(provided, secret);
}

export function getClientIp(request) {
  // With Cloudflare proxy → Vercel, x-real-ip is the CF edge IP (shared
  // across users). cf-connecting-ip is the actual client IP set by
  // Cloudflare — prefer it (only when it provably came through CF; see
  // cfIngressTrusted).
  //
  // x-forwarded-for is client-settable and MUST NOT be trusted for rate
  // limiting (#3531) — without that fallback removed, a caller bypassing
  // CF entirely (direct request) could rotate identities by toggling the
  // header and beat the per-IP window. When neither trusted header is
  // present we return the UNKNOWN_CLIENT_IP sentinel so Upstash treats
  // the whole untrusted-identity population as one shared bucket.
  //
  // Trim each header value before falling through — a whitespace-only
  // cf-connecting-ip would otherwise short-circuit past x-real-ip.
  // (Mirrors getClientIp in server/_shared/rate-limit.ts.)
  const cf = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const xr = (request.headers.get('x-real-ip') ?? '').trim();
  if (cf && cfIngressTrusted(request)) return cf;
  return xr || UNKNOWN_CLIENT_IP;
}

// Decide the Sentry level for a degraded-rate-limit capture. Upstash runtime
// transients — the Lua limiter script timing out under fan-out load
// (`ERR Error running script: execution timed out`), a dropped command, or a
// network/timeout blip — are absorbed by the fail-open / `failClosed`-503 path,
// so the user is unaffected. Capture those at `warning` so a sustained Redis
// outage still escalates by volume without a transient script-timeout drowning
// genuine error-level signal in the dashboard (WORLDMONITOR-RX; mirrors the
// SERVICE_UNAVAILABLE `level: 'warning'` precedent in api/user-prefs.ts). A
// `missing-config` stage is a real deploy misconfiguration and any novel error
// is unclassified — both stay at `error` so on-call still sees them.
// Mirrored verbatim in server/_shared/rate-limit.ts.
function rateLimitErrorLevel(stage, msg) {
  if (stage.includes('missing-config')) return 'error';
  if (/Error running script|execution timed out|Command failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timed out|socket hang up/i.test(msg)) {
    return 'warning';
  }
  return 'error';
}

function logRateLimitDegraded(stage, err, ctx) {
  const msg = err instanceof Error ? err.message : String(err);
  // Keep the prefix stable — server/_shared/rate-limit.ts emits the same
  // shape and operators grep across both surfaces.
  console.error(`[rate-limit] redis-error stage=${stage} msg=${msg}`);
  captureSilentError(err, {
    tags: { surface: 'api', component: 'rate-limit', stage },
    fingerprint: ['rate-limit', 'redis-error', stage],
    ctx,
    level: rateLimitErrorLevel(stage, msg),
  });
}

function rateLimitDegradedResponse(corsHeaders) {
  return jsonResponse(
    { error: 'Rate-limit service temporarily unavailable' },
    503,
    { ...RATE_LIMIT_DEGRADED_HEADERS, ...corsHeaders },
  );
}

/**
 * @param {Request} request
 * @param {Record<string, string>} corsHeaders
 * @param {{ failClosed?: boolean, ctx?: { waitUntil: (p: Promise<unknown>) => void } }} [opts]
 *   When `failClosed` is true and Redis is unavailable, return a 503 with
 *   the `X-RateLimit-Mode: degraded` marker instead of allowing the
 *   request through. Pass `true` for endpoints where the rate-limit IS
 *   the abuse defence (LLM, checkout). Default `false` keeps the
 *   availability-first posture for general traffic so a Redis blip
 *   doesn't black-hole the whole site. `ctx` is the Vercel handler
 *   context — passing it lets the Sentry envelope dispatch survive
 *   isolate teardown. (#3531)
 */
export async function checkRateLimit(request, corsHeaders, opts = {}) {
  const rl = getRatelimit();
  if (!rl) {
    if (opts.failClosed) {
      logRateLimitDegraded('checkRateLimit:missing-config', new Error('Upstash Redis is not configured'), opts.ctx);
      return rateLimitDegradedResponse(corsHeaders);
    }
    return null;
  }

  const ip = getClientIp(request);
  try {
    const { success, limit, reset } = await rl.limit(ip);

    if (!success) {
      return jsonResponse({ error: 'Too many requests' }, 429, {
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(reset),
        'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
        ...corsHeaders,
      });
    }

    return null;
  } catch (err) {
    logRateLimitDegraded('checkRateLimit', err, opts.ctx);
    if (opts.failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}
