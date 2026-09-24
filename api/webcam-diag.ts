// TEMPORARY read-only webcam diagnostic. Every Redis component works in
// isolation, so call the REAL listWebcams() directly with fresh bounds to see
// whether the assembly (or its response cache) is where the [] appears. No
// writes of our own. REMOVE after pinpointing.
import { listWebcams } from '../server/worldmonitor/webcam/v1/list-webcams';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  // Fresh bounds (unique quantized cacheKey) over dense Europe, zoom 9.
  const boundsA = { boundW: 21, boundS: 54, boundE: 29, boundN: 61, zoom: 9 };
  // A second, different fresh viewport.
  const boundsB = { boundW: -11, boundS: 41, boundE: 7, boundN: 59, zoom: 5 };

  const ctx = { request: req } as unknown as Parameters<typeof listWebcams>[0];

  let a: unknown, b: unknown, err: string | null = null;
  try {
    const ra = await listWebcams(ctx, boundsA as Parameters<typeof listWebcams>[1]);
    a = { totalInView: ra.totalInView, webcams: ra.webcams?.length ?? 0, clusters: ra.clusters?.length ?? 0 };
    const rb = await listWebcams(ctx, boundsB as Parameters<typeof listWebcams>[1]);
    b = { totalInView: rb.totalInView, webcams: rb.webcams?.length ?? 0, clusters: rb.clusters?.length ?? 0 };
  } catch (e) {
    err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return new Response(JSON.stringify({ realListWebcams_A: a, realListWebcams_B: b, error: err }, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
