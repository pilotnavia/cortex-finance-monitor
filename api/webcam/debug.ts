export const config = { runtime: 'edge' };

// TEMP DIAGNOSTIC #2 (Adrian 2026-09-24): list-webcams sigue en 0 tras el clamp+reseed, hasta en
// boxes chicos con camaras (Cabo Verde). Traza el path del reader para un box conocido-con-datos.
// BORRAR tras diagnosticar.
import { getCachedJson, getCachedRawString, runRedisPipeline, geoSearchByBox, getHashFieldsBatch } from '../../server/_shared/redis';
import { listWebcams } from '../../server/worldmonitor/webcam/v1/list-webcams';

export default async function handler(): Promise<Response> {
  const out: Record<string, unknown> = {
    buildMarker: 'debug2-2026-09-24',
    vercelEnv: process.env.VERCEL_ENV || '(unset)',
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || '(unset)',
  };

  const version = await getCachedRawString('webcam:cameras:active');
  out.activeVersion = version;
  if (!version) return json(out);

  const geoKey = `webcam:cameras:meta:${version}`.replace('meta', 'geo');
  const metaKey = `webcam:cameras:meta:${version}`;

  try {
    const z = await runRedisPipeline([['ZCARD', geoKey]], true);
    out.geoZcard = z?.[0]?.result ?? null;
  } catch (e) { out.geoZcard_err = String(e); }

  // Box "Africa/Atlantico" que contiene Cabo Verde: boundW-30 boundS10 boundE-15 boundN25.
  const qW = -30, qS = 10, qE = -15, qN = 25, zoom = 5;
  const centerLat = (qN + qS) / 2;
  const centerLon = (qW + qE) / 2;
  const heightKm = Math.abs(qN - qS) * 111.32;
  const widthKm = Math.abs(qE - qW) * 111.32 * Math.cos((centerLat * Math.PI) / 180);
  out.box = { centerLon, centerLat, widthKm: Math.round(widthKm), heightKm: Math.round(heightKm) };

  // 1) geoSearchByBox con centro real
  try {
    const ids = await geoSearchByBox(geoKey, centerLon, centerLat, widthKm, heightKm, 2000, true);
    out.geoSearchByBox_africa = { count: ids.length, sample: ids.slice(0, 3) };
    if (ids.length) {
      const m = await getHashFieldsBatch(metaKey, ids.slice(0, 3), true);
      out.metaSample = [...m.values()].map((v) => { try { const o = JSON.parse(v); return { t: o.title, lat: o.lat, lng: o.lng }; } catch { return 'PARSE_FAIL'; } });
    }
  } catch (e) { out.geoSearchByBox_africa_err = String(e); }

  // 2) raw GEOSEARCH mismo box
  try {
    const res = await runRedisPipeline([
      ['GEOSEARCH', geoKey, 'FROMLONLAT', String(centerLon), String(centerLat), 'BYBOX', String(widthKm), String(heightKm), 'km', 'ASC', 'COUNT', '5'],
    ], true);
    out.rawGeosearch_africa = res?.[0]?.result ?? res?.[0] ?? null;
  } catch (e) { out.rawGeosearch_africa_err = String(e); }

  // 3) cache key para ese box (envenenado?)
  const cacheKey = `webcam:resp:${version}:${zoom}:${qW}:${qS}:${qE}:${qN}`;
  try { out.cacheKeyRaw = (await getCachedRawString(cacheKey)) ?? null; } catch (e) { out.cacheKey_err = String(e); }

  // 4) listWebcams end-to-end (leera/escribira cache)
  try {
    const res = await listWebcams({} as never, { boundW: qW, boundS: qS, boundE: qE, boundN: qN, zoom } as never);
    out.listWebcams_africa = { total: (res as { totalInView?: number }).totalInView, webcams: (res as { webcams?: unknown[] }).webcams?.length };
  } catch (e) { out.listWebcams_africa_err = String(e); }

  return json(out);
}

function json(o: unknown): Response {
  return new Response(JSON.stringify(o, null, 2), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
