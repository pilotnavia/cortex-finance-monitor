export const config = { runtime: 'edge' };

// TEMP DIAGNOSTIC (Adrian 2026-09-24): por que list-webcams devuelve 0 con 1050 camaras sembradas.
// Reporta si el prefijo de clave (getKeyPrefix) o el UPSTASH no coinciden con lo que escribe el seed.
// BORRAR tras diagnosticar.
import { getCachedJson, getCachedRawString, runRedisPipeline, geoSearchByBox } from '../../server/_shared/redis';

export default async function handler(): Promise<Response> {
  const env = process.env.VERCEL_ENV || '(unset)';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  const computedPrefix = !env || env === 'production' ? '' : `${env}:${sha}:`;

  // Prefixed read (what list-webcams uses) vs raw read (unprefixed, what the seed wrote).
  const versionPrefixed = await getCachedJson('webcam:cameras:active');
  const versionRaw = await getCachedRawString('webcam:cameras:active');

  const out: Record<string, unknown> = {
    vercelEnv: env,
    computedPrefix,
    versionPrefixed: versionPrefixed ?? null,
    versionRaw: versionRaw ?? null,
  };

  const v = versionRaw || (versionPrefixed != null ? String(versionPrefixed) : null);
  if (v) {
    const geoKey = `webcam:cameras:geo:${v}`;
    try {
      const res = await runRedisPipeline([['ZCARD', geoKey]], true);
      out.geoZcardRaw = res?.[0]?.result ?? null;
    } catch (e) {
      out.geoZcardErr = e instanceof Error ? e.message : String(e);
    }
    // Exact reader helper (no response cache). Global-ish box.
    try {
      const ids = await geoSearchByBox(geoKey, 0, 0, 40000, 20000, 2000, true);
      out.geoSearchByBox_global = { count: ids.length, sample: ids.slice(0, 3) };
    } catch (e) {
      out.geoSearchByBox_err = e instanceof Error ? e.message : String(e);
    }
    // Raw GEOSEARCH via pipeline (reader grammar: ASC before COUNT) to compare.
    try {
      const res = await runRedisPipeline([
        ['GEOSEARCH', geoKey, 'FROMLONLAT', '0', '0', 'BYBOX', '40000', '20000', 'km', 'ASC', 'COUNT', '5'],
      ], true);
      const r = res?.[0]?.result;
      out.rawGeosearch = Array.isArray(r) ? { count: r.length, sample: r.slice(0, 3) } : r;
    } catch (e) {
      out.rawGeosearch_err = e instanceof Error ? e.message : String(e);
    }
  }

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
