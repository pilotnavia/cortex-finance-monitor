// TEMPORARY read-only webcam diagnostic. Reports what the deployed list-webcams
// function sees in Redis: env/prefix, the active version pointer (raw vs
// prefixed), the geo-set ZCARD, and a raw GEOSEARCH (small + global). No writes.
// REMOVE after pinpointing the empty-panel cause.
export const config = { runtime: 'edge' };

async function redis(cmd: (string | number)[]): Promise<{ result?: unknown; error?: string }> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { error: 'no upstash env' };
  try {
    const r = await fetch(`${url}/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd.map(String)),
    });
    return (await r.json()) as { result?: unknown; error?: string };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const count = (r: { result?: unknown }): number | unknown =>
  Array.isArray(r?.result) ? r.result.length : (r?.result ?? r);

export default async function handler(): Promise<Response> {
  const env = process.env.VERCEL_ENV || '(unset)';
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8);
  const prefix = !env || env === 'production' ? '' : `${env}:${sha}:`;

  const activeRaw = await redis(['GET', 'webcam:cameras:active']);
  const activePrefixed = await redis(['GET', `${prefix}webcam:cameras:active`]);

  const version = activeRaw?.result != null ? String(activeRaw.result) : null;
  const geoKey = version ? `webcam:cameras:geo:${version}` : null;

  const zcardRaw = geoKey ? await redis(['ZCARD', geoKey]) : null;
  const zcardPrefixed = geoKey ? await redis(['ZCARD', `${prefix}${geoKey}`]) : null;

  // Raw GEOSEARCH: small box over central Europe, and a global-ish clamped box.
  const geoEurope = geoKey
    ? await redis(['GEOSEARCH', geoKey, 'FROMLONLAT', '10', '48', 'BYBOX', '2000', '2000', 'km', 'ASC', 'COUNT', '5'])
    : null;
  const geoGlobal = geoKey
    ? await redis(['GEOSEARCH', geoKey, 'FROMLONLAT', '0', '0', 'BYBOX', '39000', '19000', 'km', 'ASC', 'COUNT', '5'])
    : null;

  const body = {
    env,
    sha,
    prefix: prefix || '(empty)',
    activeRaw: activeRaw?.result ?? activeRaw,
    activePrefixed: activePrefixed?.result ?? activePrefixed,
    version,
    geoKey,
    zcardRaw: zcardRaw ? count(zcardRaw) : null,
    zcardPrefixed: zcardPrefixed ? count(zcardPrefixed) : null,
    geoEuropeCount: geoEurope ? count(geoEurope) : null,
    geoEuropeSample: Array.isArray(geoEurope?.result) ? geoEurope.result.slice(0, 3) : null,
    geoGlobalCount: geoGlobal ? count(geoGlobal) : null,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
