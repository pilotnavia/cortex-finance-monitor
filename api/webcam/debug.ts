export const config = { runtime: 'edge' };

// TEMP DIAGNOSTIC (Adrian 2026-09-24): por que list-webcams devuelve 0 con 1050 camaras sembradas.
// Reporta si el prefijo de clave (getKeyPrefix) o el UPSTASH no coinciden con lo que escribe el seed.
// BORRAR tras diagnosticar.
import { getCachedJson, getCachedRawString, runRedisPipeline } from '../../server/_shared/redis';

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
    try {
      const res = await runRedisPipeline([['ZCARD', `webcam:cameras:geo:${v}`]], true);
      out.geoZcardRaw = res?.[0]?.result ?? null;
    } catch (e) {
      out.geoZcardErr = e instanceof Error ? e.message : String(e);
    }
  }

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
