#!/usr/bin/env node
// Seeds `market:sectors:v2` (sector heatmap / GetSectorSummary) from the 11
// SPDR sector ETFs via Yahoo Finance chart API. No API key required.
//
// Cortex fork note: upstream seeds this key from its private Railway relay
// (see server/worldmonitor/market/v1/get-sector-summary.ts header comment),
// so the repo had no writer for it. This seed fills that gap with the exact
// shape the handler returns: { sectors: [{ symbol, name, change }] }.

import { loadEnvFile, runSeed, CHROME_UA, sleep } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const SECTORS_KEY = 'market:sectors:v2';
const SECTORS_TTL = 21600; // 6h = 3x the 2h workflow interval

// SPDR Select Sector ETFs -> S&P 500 sector names
const SECTOR_ETFS = [
  ['XLK', 'Technology'],
  ['XLF', 'Financials'],
  ['XLE', 'Energy'],
  ['XLV', 'Health Care'],
  ['XLY', 'Consumer Discretionary'],
  ['XLP', 'Consumer Staples'],
  ['XLI', 'Industrials'],
  ['XLB', 'Materials'],
  ['XLU', 'Utilities'],
  ['XLRE', 'Real Estate'],
  ['XLC', 'Communication Services'],
];

async function fetchSectorChange(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const headers = { 'User-Agent': CHROME_UA, Accept: 'application/json' };
  try {
    const text = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).then(r => {
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      return r.text();
    });
    const result = JSON.parse(text)?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta ?? {};
    const price = meta.regularMarketPrice;
    // Prefer Yahoo's own previous close; fall back to last two daily closes.
    let prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
    if (prev == null) {
      const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(v => v != null);
      prev = closes.length >= 2 ? closes[closes.length - 2] : null;
    }
    if (typeof price !== 'number' || typeof prev !== 'number' || prev === 0) return null;
    return ((price - prev) / prev) * 100;
  } catch (e) {
    console.warn(`  Yahoo ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchAll() {
  const sectors = [];
  for (const [symbol, name] of SECTOR_ETFS) {
    const change = await fetchSectorChange(symbol);
    if (change != null) {
      sectors.push({ symbol, name, change: Number(change.toFixed(2)) });
      console.log(`  ${symbol} ${name}: ${change > 0 ? '+' : ''}${change.toFixed(2)}%`);
    }
    await sleep(150);
  }
  return { sectors };
}

function validate(payload) {
  return Array.isArray(payload?.sectors) && payload.sectors.length >= 6;
}

runSeed('market', 'sectors', SECTORS_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: SECTORS_TTL,
  sourceVersion: 'yahoo-spdr-v1',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
