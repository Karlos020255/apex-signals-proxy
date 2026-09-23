// ── APEX SIGNALS BACKTEST ──────────────────────────────────────
// Spielt historische 15min/4H Kerzen durch, fragt Claude/Gemini/GPT mit den
// LIVE-Prompts und prüft bei Konsens (alle KIs BUY oder alle SELL), ob TP oder SL
// zuerst getroffen wurde. Vergleich: reine Regel-Strategie ohne KI.
//
// Aufruf:
//   node backtest.js --pair EUR/USD --from 2026-06-20 --to 2026-09-20
//   node backtest.js --pair EUR/USD --dry-run          (nur Regeln, keine KI-Kosten)
//
// Keys aus Umgebung oder .env: TWELVE_KEY, CLAUDE_API_KEY, GEMINI_KEY, OPENAI_KEY

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// .env laden (ohne Zusatz-Paket), muss VOR require('./proxy-server') passieren
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { getSession, callClaude, callGemini, callGPT } = require('./proxy-server');

// ── OPTIONEN ───────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[key] = true;
    else { a[key] = next; i++; }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const OPT = {
  pairs:       String(args.pair || 'EUR/USD').split(',').map(s => s.trim().toUpperCase()),
  from:        args.from || daysAgo(92),
  to:          args.to || daysAgo(2),
  step:        parseInt(args.step || 16),          // alle 16 Kerzen = alle 4h ein Prüfpunkt
  horizon:     parseInt(args.horizon || 96),       // max. 96 Kerzen = 24h Haltedauer
  maxPoints:   parseInt(args['max-points'] || 400),
  shiftPips:   parseFloat(args['shift-pips'] ?? 250), // Preise verschieben, damit KIs den Zeitpunkt nicht erkennen
  concurrency: parseInt(args.concurrency || 3),
  dryRun:      !!args['dry-run'],
  yes:         !!args.yes
};

const DATA_DIR = process.env.BACKTEST_DIR || path.join(__dirname, 'backtest-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SPREAD_PIPS = { 'EUR/USD':1.0, 'GBP/USD':1.5, 'USD/JPY':1.0, 'GBP/JPY':2.5, 'EUR/GBP':1.2, 'AUD/USD':1.2, 'USD/CAD':1.8, 'XAU/USD':3.0 };
const pipSize  = pair => pair.includes('JPY') ? 0.01 : pair.includes('XAU') ? 0.1 : 0.0001;
const decimals = pair => pair.includes('JPY') ? 3 : pair.includes('XAU') ? 2 : 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = dt => Date.parse(dt.replace(' ', 'T') + 'Z');

// ── HISTORISCHE KERZEN (Twelve Data, mit Cache) ────────────────
async function fetchCandles(pair, interval, from, to) {
  const file = path.join(DATA_DIR, `candles_${pair.replace('/', '')}_${interval}_${from}_${to}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  const key = process.env.TWELVE_KEY;
  if (!key) throw new Error('TWELVE_KEY fehlt (Umgebungsvariable oder .env)');

  const all = [];
  let cursor = `${from} 00:00:00`;
  const end = `${to} 23:59:59`;
  while (true) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}` +
      `&start_date=${encodeURIComponent(cursor)}&end_date=${encodeURIComponent(end)}&outputsize=5000&order=asc&timezone=UTC&apikey=${key}`;
    const d = await (await fetch(url)).json();
    if (d.status === 'error') throw new Error(`Twelve Data: ${d.message}`);
    const vals = d.values || [];
    all.push(...vals.filter(v => !all.length || ts(v.datetime) > ts(all[all.length - 1].datetime)));
    console.log(`  ${pair} ${interval}: ${all.length} Kerzen geladen`);
    if (vals.length < 5000) break;
    cursor = new Date(ts(vals[vals.length - 1].datetime) + 1000).toISOString().replace('T', ' ').slice(0, 19);
    await sleep(8000); // Free-Tier: 8 Requests/Minute
  }
  fs.writeFileSync(file, JSON.stringify(all));
  return all;
}

// ── MARKTDATEN ZUM ZEITPUNKT i (identisch zu getLiveMarketData) ──
function marketAt(pair, c15, c4h, i) {
  const dec = decimals(pair);
  const closeTime = ts(c15[i].datetime) + 15 * 60e3;
  // nur abgeschlossene 4H Kerzen → kein Blick in die Zukunft
  const done4h = c4h.filter(c => ts(c.datetime) + 4 * 3600e3 <= closeTime);
  if (i < 19 || done4h.length < 10) return null;

  const d15 = c15.slice(i - 19, i + 1).reverse();  // neueste zuerst, wie Twelve Data live
  const d4h = done4h.slice(-10).reverse();

  const closes15 = d15.map(c => parseFloat(c.close)).reverse();
  const gains = [], losses = [];
  for (let k = 1; k < closes15.length; k++) {
    const diff = closes15[k] - closes15[k - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }
  const avgGain = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const avgLoss = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const rsi = (100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)))).toFixed(2);

  const k20 = 2 / 21;
  let ema20 = closes15[0];
  for (let k = 1; k < Math.min(closes15.length, 20); k++) ema20 = closes15[k] * k20 + ema20 * (1 - k20);

  const closes4h = d4h.map(c => parseFloat(c.close)).reverse();
  const k50 = 2 / 51;
  let ema50 = closes4h[0];
  for (let k = 1; k < closes4h.length; k++) ema50 = closes4h[k] * k50 + ema50 * (1 - k50);

  const f = v => parseFloat(v).toFixed(dec);
  return {
    closeTime,
    currentPrice: f(d15[0].close),
    candles15: d15.slice(0, 5).map(c => `${c.datetime.split(' ')[1]} O:${f(c.open)} H:${f(c.high)} L:${f(c.low)} C:${f(c.close)}`).join(' | '),
    // Datum durch t-1, t-2 ... ersetzt, damit die KI den Zeitpunkt nicht erkennt
    candles4h: d4h.slice(0, 3).map((c, n) => `t-${n + 1} O:${f(c.open)} H:${f(c.high)} L:${f(c.low)} C:${f(c.close)}`).join(' | '),
    rsi: rsi.toString(),
    ema20: ema20.toFixed(dec),
    ema50_4h: ema50.toFixed(dec)
  };
}

// ── TRADE AUSWERTEN: was wird zuerst getroffen, SL oder TP? ────
function evaluateTrade(pair, c15, i, dir, entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const cost = SPREAD_PIPS[pair] ?? 1.5;
  const costR = (cost * pipSize(pair)) / risk;
  const last = Math.min(i + OPT.horizon, c15.length - 1);

  for (let j = i + 1; j <= last; j++) {
    const hi = parseFloat(c15[j].high), lo = parseFloat(c15[j].low);
    const hitSL = dir === 'BUY' ? lo <= sl : hi >= sl;
    const hitTP = dir === 'BUY' ? hi >= tp : lo <= tp;
    // beide in derselben Kerze → konservativ als Verlust werten
    if (hitSL) return { outcome: 'SL', R: -1 - costR, bars: j - i };
    if (hitTP) return { outcome: 'TP', R: Math.abs(tp - entry) / risk - costR, bars: j - i };
  }
  const exit = parseFloat(c15[last].close);
  const R = (dir === 'BUY' ? exit - entry : entry - exit) / risk - costR;
  return { outcome: 'TIMEOUT', R, bars: last - i };
}

// SL/TP der KI prüfen, bei Unsinn Standard 15/30 Pips verwenden
function levels(pair, dir, entry, r) {
  const pip = pipSize(pair);
  const sl = parseFloat(r && r.sl), tp = parseFloat(r && r.tp);
  const valid = dir === 'BUY' ? (sl < entry && tp > entry) : (sl > entry && tp < entry);
  if (valid && Math.abs(entry - sl) <= 40 * pip) return { sl, tp, fallback: false };
  const s = dir === 'BUY' ? 1 : -1;
  return { sl: entry - s * 15 * pip, tp: entry + s * 30 * pip, fallback: true };
}

// Referenz ohne KI: EMA-Stack + RSI-Bereich (Regeln aus dem Gemini-Prompt)
function ruleSignal(m) {
  const p = parseFloat(m.currentPrice), e20 = parseFloat(m.ema20), e50 = parseFloat(m.ema50_4h), rsi = parseFloat(m.rsi);
  if (p > e20 && e20 > e50 && rsi >= 40 && rsi <= 65) return 'BUY';
  if (p < e20 && e20 < e50 && rsi >= 35 && rsi <= 60) return 'SELL';
  return 'NEUTRAL';
}

// ── KI ABFRAGEN (mit Cache, damit ein Abbruch nichts kostet) ───
const NEWS = 'Keine News verfuegbar (Backtest) | GESAMT-SENTIMENT: NEUTRAL (Score: 0)';
const CALENDAR = 'Keine Kalenderdaten (Backtest)';

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= 2) throw e;
      await sleep(5000 * (attempt + 1));
    }
  }
}

function applyConfidenceFilter(r) {
  // identisch zu /analyze: Signale unter 4/10 → NEUTRAL
  if (r.error) return r;
  const conf = parseInt(r.confidence) || 0;
  if (r.signal !== 'NEUTRAL' && conf < 4) return { ...r, signal: 'NEUTRAL', originalSignal: r.signal };
  return r;
}

async function askAIs(pair, m, session) {
  const calls = [];
  if (process.env.CLAUDE_API_KEY) calls.push(withRetry(() => callClaude(pair, m, NEWS, CALENDAR, session)).then(r => ({ ...r, ai: 'claude' })).catch(e => ({ ai: 'claude', error: e.message })));
  if (process.env.GEMINI_KEY)     calls.push(withRetry(() => callGemini(process.env.GEMINI_KEY, pair, m, NEWS, CALENDAR, session)).then(r => ({ ...r, ai: 'gemini' })).catch(e => ({ ai: 'gemini', error: e.message })));
  if (process.env.OPENAI_KEY)     calls.push(withRetry(() => callGPT(process.env.OPENAI_KEY, pair, m, NEWS, CALENDAR, session)).then(r => ({ ...r, ai: 'openai' })).catch(e => ({ ai: 'openai', error: e.message })));
  return (await Promise.all(calls)).map(applyConfidenceFilter);
}

async function pool(items, n, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const k = next++; await worker(items[k], k); }
  }));
}

// ── STATISTIK ──────────────────────────────────────────────────
function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.R > 0).length;
  const sumR = trades.reduce((a, t) => a + t.R, 0);
  const pos = trades.filter(t => t.R > 0).reduce((a, t) => a + t.R, 0);
  const neg = -trades.filter(t => t.R < 0).reduce((a, t) => a + t.R, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += t.R; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    n,
    tp: trades.filter(t => t.outcome === 'TP').length,
    sl: trades.filter(t => t.outcome === 'SL').length,
    timeout: trades.filter(t => t.outcome === 'TIMEOUT').length,
    winrate: (100 * wins / n).toFixed(1) + '%',
    avgR: (sumR / n).toFixed(3),
    sumR: sumR.toFixed(2),
    profitFactor: neg ? (pos / neg).toFixed(2) : '∞',
    maxDrawdownR: dd.toFixed(2)
  };
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.table(Object.fromEntries(rows.map(([name, list]) => [name, stats(list)])));
}

// ── HAUPTLAUF PRO PAIR ─────────────────────────────────────────
async function runPair(pair) {
  console.log(`\n══ ${pair}  ${OPT.from} → ${OPT.to} ══`);
  const raw15 = await fetchCandles(pair, '15min', OPT.from, OPT.to);
  const raw4h = await fetchCandles(pair, '4h', daysBefore(OPT.from, 5), OPT.to);

  // Preise um konstanten Betrag verschieben: Pip-Abstände bleiben gleich, Kurs ist unbekannt
  const shift = OPT.shiftPips * pipSize(pair);
  const shiftC = c => ({ ...c, open: +c.open + shift, high: +c.high + shift, low: +c.low + shift, close: +c.close + shift });
  const c15 = raw15.map(shiftC), c4h = raw4h.map(shiftC);

  // Prüfpunkte: alle `step` Kerzen, mit genug Zukunft für die Auswertung
  const points = [];
  for (let i = 19; i + OPT.horizon < c15.length; i += OPT.step) {
    const m = marketAt(pair, c15, c4h, i);
    if (m) points.push({ i, m, time: c15[i].datetime, session: getSession(new Date(m.closeTime).getUTCHours()) });
  }
  if (points.length > OPT.maxPoints) points.splice(0, points.length - OPT.maxPoints); // neueste behalten
  console.log(`  ${points.length} Prüfpunkte (alle ${OPT.step} Kerzen, Haltedauer max. ${OPT.horizon} Kerzen)`);

  // Regel-Referenz (kostenlos)
  const ruleTrades = [];
  for (const p of points) {
    const dir = ruleSignal(p.m);
    if (dir === 'NEUTRAL') continue;
    const entry = parseFloat(p.m.currentPrice);
    const lv = levels(pair, dir, entry, null);
    ruleTrades.push({ time: p.time, session: p.session, dir, ...evaluateTrade(pair, c15, p.i, dir, entry, lv.sl, lv.tp) });
  }

  const report = { pair, ruleTrades, consensusTrades: [], perAI: {} };
  if (OPT.dryRun) { printTable(`${pair} — nur Regeln (Dry-Run)`, [['Regeln ohne KI', ruleTrades]]); return report; }

  const ais = ['claude', 'gemini', 'openai'].filter(ai => process.env[{ claude: 'CLAUDE_API_KEY', gemini: 'GEMINI_KEY', openai: 'OPENAI_KEY' }[ai]]);
  if (!ais.length) throw new Error('Keine KI-Keys gesetzt (CLAUDE_API_KEY, GEMINI_KEY, OPENAI_KEY) – oder --dry-run nutzen');
  if (ais.length < 3) console.warn(`  ⚠ Nur ${ais.join(', ')} aktiv – Konsens = alle aktiven KIs`);

  // Cache laden: bereits abgefragte Punkte kosten beim Neustart nichts
  const cacheFile = path.join(DATA_DIR, `ai_${pair.replace('/', '')}_shift${OPT.shiftPips}.jsonl`);
  const cache = new Map();
  if (fs.existsSync(cacheFile)) {
    for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (!e.results.some(r => r.error)) cache.set(e.time, e.results);
    }
  }
  const todo = points.filter(p => !cache.has(p.time));
  const cost = todo.length * (0.02 * ais.includes('claude') + 0.005 * ais.includes('openai') + 0.001 * ais.includes('gemini'));
  console.log(`  ${cache.size} aus Cache, ${todo.length} neu abzufragen – geschätzte Kosten ca. $${cost.toFixed(2)}`);
  if (todo.length && !OPT.yes) { console.log('  Start in 10 Sekunden … (Strg+C zum Abbrechen, --yes überspringt die Wartezeit)'); await sleep(10000); }

  let done = 0;
  await pool(todo, OPT.concurrency, async p => {
    const results = await askAIs(pair, p.m, p.session);
    cache.set(p.time, results);
    fs.appendFileSync(cacheFile, JSON.stringify({ time: p.time, results }) + '\n');
    done++;
    const errs = results.filter(r => r.error).map(r => `${r.ai}: ${r.error.slice(0, 60)}`);
    console.log(`  [${done}/${todo.length}] ${p.time}  ${results.map(r => `${r.ai}=${r.error ? 'FEHLER' : r.signal}`).join(' ')}${errs.length ? '  ← ' + errs.join(' | ') : ''}`);
  });

  let errorPoints = 0, fallbacks = 0;
  for (const ai of ais) report.perAI[ai] = [];
  for (const p of points) {
    const results = cache.get(p.time) || [];
    const entry = parseFloat(p.m.currentPrice);
    for (const r of results) {
      if (r.error || r.signal === 'NEUTRAL' || !report.perAI[r.ai]) continue;
      const lv = levels(pair, r.signal, entry, r);
      report.perAI[r.ai].push({ time: p.time, session: p.session, dir: r.signal, ...evaluateTrade(pair, c15, p.i, r.signal, entry, lv.sl, lv.tp) });
    }
    if (results.length < ais.length || results.some(r => r.error)) { errorPoints++; continue; }
    const sigs = results.map(r => r.signal);
    if (sigs.every(s => s === 'BUY') || sigs.every(s => s === 'SELL')) {
      const dir = sigs[0];
      // wie live: Levels der ersten KI (Claude) verwenden
      const lv = levels(pair, dir, entry, results[0]);
      if (lv.fallback) fallbacks++;
      report.consensusTrades.push({ time: p.time, session: p.session, dir, ...evaluateTrade(pair, c15, p.i, dir, entry, lv.sl, lv.tp) });
    }
  }

  printTable(`${pair} — Ergebnisse (R = Vielfaches des Risikos, nach Spread)`, [
    [`KONSENS (${ais.length}/${ais.length})`, report.consensusTrades],
    ...ais.map(ai => [`nur ${ai}`, report.perAI[ai]]),
    ['Regeln ohne KI', ruleTrades]
  ]);
  const sessions = [...new Set(report.consensusTrades.map(t => t.session))];
  if (sessions.length) printTable(`${pair} — Konsens nach Session`, sessions.map(s => [s, report.consensusTrades.filter(t => t.session === s)]));
  if (errorPoints) console.log(`  ⚠ ${errorPoints} Prüfpunkte mit KI-Fehlern nicht im Konsens gewertet (erneuter Start fragt sie neu ab)`);
  if (fallbacks) console.log(`  ℹ ${fallbacks} Konsens-Trades mit ungültigen KI-Levels → Standard 15/30 Pips verwendet`);
  return report;
}

function daysBefore(date, n) {
  return new Date(Date.parse(date) - n * 864e5).toISOString().slice(0, 10);
}

function writeCSV(reports) {
  const rows = ['pair,strategie,zeit_utc,session,richtung,ergebnis,R,kerzen'];
  for (const rep of reports) {
    const add = (name, list) => list.forEach(t => rows.push([rep.pair, name, t.time, t.session, t.dir, t.outcome, t.R.toFixed(3), t.bars].join(',')));
    add('konsens', rep.consensusTrades);
    for (const [ai, list] of Object.entries(rep.perAI)) add(ai, list);
    add('regeln', rep.ruleTrades);
  }
  const file = path.join(DATA_DIR, `trades_${OPT.from}_${OPT.to}.csv`);
  fs.writeFileSync(file, rows.join('\n'));
  console.log(`\nAlle Trades gespeichert: ${file}`);
}

(async () => {
  console.log('APEX SIGNALS BACKTEST', JSON.stringify(OPT));
  console.log('Hinweis: Bei 1:2 RRR liegt die Gewinnschwelle bei ~33% Trefferquote. Ohne News/Kalender – nur Kerzen & Indikatoren.');
  const reports = [];
  for (const pair of OPT.pairs) {
    try { reports.push(await runPair(pair)); }
    catch (e) { console.error(`  ✖ ${pair}: ${e.message}`); }
  }
  if (reports.length) writeCSV(reports);
})();
