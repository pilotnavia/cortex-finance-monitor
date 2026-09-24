export const config = { runtime: 'edge' };

// TEMP DIAGNOSTIC (Adrian 2026-09-24): por que list-webcams devuelve 0 con 1050 camaras sembradas.
// Reporta si el prefijo de clave (getKeyPrefix) o el UPSTASH no coinciden con lo que escribe el seed.
// BORRAR tras diagnosticar.
import { getCachedJson, getCachedRawString, runRedisPipeline, geoSearchByBox, getHashFieldsBatch } from '../../server/_shared/redis';
import { listWebcams } from '../../server/worldmonitor/webcam/v1/list-webcams';

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

    // Meta fetch for the sample ids (does HMGET + JSON.parse round-trip work?)
    try {
      const ids = await geoSearchByBox(geoKey, 0, 0, 40000, 20000, 5, true);
      const metaKey = `webcam:cameras:meta:${v}`;
      const metaMap = await getHashFieldsBatch(metaKey, ids, true);
      const parsed: unknown[] = [];
      for (const id of ids) { const raw = metaMap.get(id); if (raw) { try { parsed.push(JSON.parse(raw)); } catch { parsed.push('PARSE_FAIL:' + raw.slice(0, 40)); } } }
      out.metaProbe = { idsAsked: ids.length, metaReturned: metaMap.size, firstParsed: parsed[0] ?? null };
    } catch (e) {
      out.metaProbe_err = e instanceof Error ? e.message : String(e);
    }

    // Reader computes BYBOX from the bbox; a full-globe box may exceed Redis GEOSEARCH limits.
    // Test the EXACT reader-global params and capture the raw error if any.
    try {
      const ids = await geoSearchByBox(geoKey, 0, 0, 40075, 20037, 2000, true);
      out.readerGlobalParams = { count: ids.length };
    } catch (e) { out.readerGlobalParams_err = e instanceof Error ? e.message : String(e); }
    try {
      const res = await runRedisPipeline([
        ['GEOSEARCH', geoKey, 'FROMLONLAT', '0', '0', 'BYBOX', '40075', '20037', 'km', 'ASC', 'COUNT', '5'],
      ], true);
      out.rawGeosearchGlobalBig = res?.[0]?.result ?? res?.[0] ?? null;
    } catch (e) { out.rawGeosearchGlobalBig_err = e instanceof Error ? e.message : String(e); }

    // Response-cache poison check for a US bbox (reader grammar for cacheKey).
    const zoom = 4, qW = -125, qS = 24, qE = -66, qN = 50;
    const cacheKey = `webcam:resp:${v}:${zoom}:${qW}:${qS}:${qE}:${qN}`;
    try {
      out.usCacheRaw = (await getCachedRawString(cacheKey)) ?? null;
    } catch (e) {
      out.usCacheErr = e instanceof Error ? e.message : String(e);
    }

    // The actual reader path end-to-end (this WILL read/write the response cache).
    try {
      const res = await listWebcams({} as never, { boundW: qW, boundS: qS, boundE: qE, boundN: qN, zoom } as never);
      out.listWebcams_US = { total: (res as { totalInView?: number }).totalInView, webcams: (res as { webcams?: unknown[] }).webcams?.length };
    } catch (e) {
      out.listWebcams_err = e instanceof Error ? e.message : String(e);
    }
  }

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
