// TEMPORARY read-only webcam diagnostic. Compares three GEOSEARCH paths on the
// SAME key/box to isolate why list-webcams returns [] while raw Redis works.
// No writes. REMOVE after pinpointing.
import { geoSearchByBox } from '../server/_shared/redis';

export const config = { runtime: 'edge' };

const URL_ = () => process.env.UPSTASH_REDIS_REST_URL;
const TOK_ = () => process.env.UPSTASH_REDIS_REST_TOKEN;

async function bodyMode(cmd: (string | number)[]): Promise<{ result?: unknown; error?: string }> {
  try {
    const r = await fetch(`${URL_()}/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK_()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd.map(String)),
    });
    return (await r.json()) as { result?: unknown; error?: string };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function pipelineMode(cmd: (string | number)[]): Promise<unknown> {
  try {
    const r = await fetch(`${URL_()}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK_()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([cmd.map(String)]),
    });
    const status = r.status;
    const data = await r.json().catch(() => null);
    return { status, ok: r.ok, data };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const len = (x: unknown): unknown => (Array.isArray(x) ? x.length : x);

export default async function handler(): Promise<Response> {
  const version = String((await bodyMode(['GET', 'webcam:cameras:active'])).result ?? '');
  const geoKey = `webcam:cameras:geo:${version}`;

  // Europe box, exactly as list-webcams computes it for boundW=-15,S35,E15,N72:
  // centerLon 0, centerLat 53.5, widthKm ~1987, heightKm ~4119, COUNT 2000.
  const lon = 0, lat = 53.5, w = 1987.4, h = 4118.8, count = 2000;
  const geoCmd = ['GEOSEARCH', geoKey, 'FROMLONLAT', lon, lat, 'BYBOX', w, h, 'km', 'ASC', 'COUNT', count];

  const body = {
    version,
    geoKey,
    // 1) raw body-mode (what worked before)
    bodyModeCount: len((await bodyMode(geoCmd)).result),
    // 2) raw /pipeline (what geoSearchByBox uses) — full raw response
    pipelineRaw: await pipelineMode(geoCmd),
    // 3) the REAL geoSearchByBox function (raw=true), same as list-webcams
    realFnCount: (await geoSearchByBox(geoKey, lon, lat, w, h, count, true)).length,
    // integer-coord control (my earlier working diag)
    intBoxCount: len((await bodyMode(['GEOSEARCH', geoKey, 'FROMLONLAT', 10, 48, 'BYBOX', 2000, 2000, 'km', 'ASC', 'COUNT', 5])).result),
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
