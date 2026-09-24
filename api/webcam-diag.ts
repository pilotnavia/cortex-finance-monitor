// TEMPORARY read-only webcam diagnostic. geoSearchByBox returns ids fine, so the
// empty panel is in the METADATA step (getHashFieldsBatch). Probe it. No writes.
// REMOVE after pinpointing.
import { geoSearchByBox, getHashFieldsBatch } from '../server/_shared/redis';

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

export default async function handler(): Promise<Response> {
  const version = String((await bodyMode(['GET', 'webcam:cameras:active'])).result ?? '');
  const geoKey = `webcam:cameras:geo:${version}`;
  const metaKey = `webcam:cameras:meta:${version}`;

  const ids = await geoSearchByBox(geoKey, 0, 53.5, 1987.4, 4118.8, 2000, true);
  const first3 = ids.slice(0, 3);

  // 1) HLEN of the meta hash (raw)
  const hlen = (await bodyMode(['HLEN', metaKey])).result;
  // 2) raw HMGET of the first 3 ids (body-mode) — does the hash hold these fields?
  const rawHmget = first3.length
    ? (await bodyMode(['HMGET', metaKey, ...first3])).result
    : null;
  // 3) the REAL getHashFieldsBatch (raw=true), same call list-webcams makes
  const batch = first3.length ? await getHashFieldsBatch(metaKey, first3, true) : new Map();

  const body = {
    version,
    metaKey,
    idsCount: ids.length,
    first3,
    hlen,
    rawHmgetSample: Array.isArray(rawHmget) ? rawHmget.map((v) => (typeof v === 'string' ? v.slice(0, 60) : v)) : rawHmget,
    batchSize: batch.size,
    batchSample: [...batch.entries()].slice(0, 2).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 60) : v]),
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
