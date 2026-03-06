const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

function getSession(hour) {
  if (hour >= 7  && hour < 12) return "LONDON";
  if (hour >= 12 && hour < 17) return "NEW YORK";
  if (hour >= 17 && hour < 21) return "LONDON/NY OVERLAP";
  return "ASIEN";
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Kein JSON in Antwort');
  return JSON.parse(text.substring(start, end + 1));
}

// ── MARKTDATEN: nur 2 Credits pro Analyse ──────────────────────
async function getLiveMarketData(pair, twelveKey) {
  if (!twelveKey) return { currentPrice:'N/A', candles15:'N/A', candles4h:'N/A', rsi:'N/A', ema20:'N/A', ema50_4h:'N/A' };
  try {
    const [r15, r4h] = await Promise.all([
      fetch(`https://api.twelvedata.com/time_series?symbol=${pair}&interval=15min&outputsize=20&apikey=${twelveKey}`),
      fetch(`https://api.twelvedata.com/time_series?symbol=${pair}&interval=4h&outputsize=10&apikey=${twelveKey}`)
    ]);
    const [d15, d4h] = await Promise.all([r15.json(), r4h.json()]);

    if (!d15.values || !d4h.values) return { currentPrice:'N/A', candles15:'N/A', candles4h:'N/A', rsi:'N/A', ema20:'N/A', ema50_4h:'N/A' };

    // RSI berechnen
    const closes15 = d15.values.map(c => parseFloat(c.close)).reverse();
    const gains = [], losses = [];
    for (let i = 1; i < closes15.length; i++) {
      const diff = closes15[i] - closes15[i-1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    const avgGain = gains.slice(-14).reduce((a,b)=>a+b,0)/14;
    const avgLoss = losses.slice(-14).reduce((a,b)=>a+b,0)/14;
    const rsi = (100 - (100/(1+(avgLoss===0?100:avgGain/avgLoss)))).toFixed(2);

    // EMA 20 (15min)
    const k20 = 2/21;
    let ema20 = closes15[0];
    for (let i = 1; i < Math.min(closes15.length,20); i++) ema20 = closes15[i]*k20 + ema20*(1-k20);

    // EMA 50 (4H)
    const closes4h = d4h.values.map(c => parseFloat(c.close)).reverse();
    const k50 = 2/51;
    let ema50 = closes4h[0];
    for (let i = 1; i < closes4h.length; i++) ema50 = closes4h[i]*k50 + ema50*(1-k50);

    return {
      currentPrice: d15.values[0].close,
      candles15: d15.values.slice(0,5).map(c=>`${c.datetime.split(' ')[1]} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | '),
      candles4h:  d4h.values.slice(0,3).map(c=>`${c.datetime.split(' ')[0]} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | '),
      rsi: rsi.toString(),
      ema20: ema20.toFixed(5),
      ema50_4h: ema50.toFixed(5)
    };
  } catch(e) {
    return { currentPrice:'N/A', candles15:'N/A', candles4h:'N/A', rsi:'N/A', ema20:'N/A', ema50_4h:'N/A' };
  }
}

// ── NEWS & KALENDER ────────────────────────────────────────────
async function getLiveNews(pair, finnhubKey) {
  if (!finnhubKey) return 'Kein Finnhub Key';
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=forex&token=${finnhubKey}`);
    const news = await r.json();
    if (!Array.isArray(news)) return 'Keine News verfuegbar';
    const currencies = pair.split('/');
    const relevant = news
      .filter(n => currencies.some(c => (n.headline||'').includes(c) || (n.summary||'').includes(c)))
      .slice(0, 3).map(n => n.headline).join(' | ');
    return relevant || 'Keine relevanten News gefunden';
  } catch(e) { return 'News nicht verfuegbar'; }
}

async function getEconomicCalendar(finnhubKey) {
  if (!finnhubKey) return 'Kein Finnhub Key';
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${finnhubKey}`);
    const d = await r.json();
    const events = d.economicCalendar || [];
    const highImpact = events.filter(e => e.impact === 'high').slice(0,5)
      .map(e => `${e.time||''} ${e.country||''} ${e.event||''}`).join(' | ');
    return highImpact || 'Keine High-Impact Events heute';
  } catch(e) { return 'Kalender nicht verfuegbar'; }
}

// ── PROMPTS ────────────────────────────────────────────────────
function claudePrompt(pair, m, news, calendar, session) {
  return `Du bist Senior Forex Makro-Analyst (Goldman Sachs, 20 Jahre).
Pair: ${pair} | Session: ${session}
LIVE MARKTDATEN: Preis=${m.currentPrice} RSI=${m.rsi} EMA20=${m.ema20} EMA50_4H=${m.ema50_4h}
15min Kerzen: ${m.candles15}
4H Kerzen: ${m.candles4h}
NEWS: ${news}
HIGH-IMPACT EVENTS: ${calendar}
Analysiere: Zentralbank-Divergenz, Geopolitik, 4H Trend, 15min Einstieg, News-Impact.
Regeln: SL max 15 Pips, TP min 1:2 RRR, bei High-Impact Events -> NEUTRAL.
NUR JSON: {"signal":"BUY oder SELL oder NEUTRAL","entry":"${m.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch"}`;
}

function geminiPrompt(pair, m, news, calendar, session) {
  return `Forex technischer Analyst. Pair: ${pair} | Session: ${session}
LIVE MARKTDATEN: Preis=${m.currentPrice} RSI=${m.rsi} EMA20=${m.ema20} EMA50_4H=${m.ema50_4h}
15min Kerzen: ${m.candles15}
4H Kerzen: ${m.candles4h}
NEWS: ${news}
HIGH-IMPACT EVENTS: ${calendar}
Analysiere: EMA Stack 4H+15min, RSI Momentum, Price Action, Key Levels.
Regeln: SL max 15 Pips, TP min 1:2 RRR.
NUR JSON: {"signal":"BUY oder SELL oder NEUTRAL","entry":"${m.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch"}`;
}

function gptPrompt(pair, m, news, calendar, session) {
  return `Forex Sentiment-Analyst. Pair: ${pair} | Session: ${session}
LIVE MARKTDATEN: Preis=${m.currentPrice} RSI=${m.rsi} EMA50_4H=${m.ema50_4h}
4H Kerzen: ${m.candles4h}
NEWS: ${news}
HIGH-IMPACT EVENTS: ${calendar}
Analysiere: Risk-on/off, DXY, News-Sentiment, 4H+15min Momentum.
Regeln: Kein Trade 30min vor High-Impact Events, SL max 15 Pips, TP 1:2-1:3 RRR.
NUR JSON: {"signal":"BUY oder SELL oder NEUTRAL","entry":"${m.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch"}`;
}

// ── KI CALLS mit Auto-Retry ────────────────────────────────────
async function callClaude(pair, m, news, calendar, session) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':process.env.CLAUDE_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:500, messages:[{ role:'user', content:claudePrompt(pair,m,news,calendar,session) }] })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return extractJSON(d.content?.[0]?.text || '');
}

// Gemini Modelle in Reihenfolge - fällt automatisch auf nächstes zurück
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
];

async function callGeminiModel(geminiKey, model, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature:0.1, maxOutputTokens:500, responseMimeType:"application/json" }
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return extractJSON(d.candidates?.[0]?.content?.parts?.[0]?.text || '');
}

async function callGemini(geminiKey, pair, m, news, calendar, session) {
  const prompt = geminiPrompt(pair, m, news, calendar, session);
  let lastError = '';

  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callGeminiModel(geminiKey, model, prompt);
      } catch(e) {
        lastError = e.message;
        const isHighDemand = e.message.includes('high demand') || e.message.includes('overloaded') || e.message.includes('503');
        const isDeprecated = e.message.includes('no longer available') || e.message.includes('deprecated') || e.message.includes('404');
        if (isDeprecated) break;
        if (isHighDemand && attempt < 2) {
          await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }
  throw new Error('Gemini nicht verfuegbar: ' + lastError);
}

async function callGPT(openaiKey, pair, m, news, calendar, session) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${openaiKey}` },
    body: JSON.stringify({
      model:'gpt-4o', max_tokens:500,
      response_format: { type:"json_object" },
      messages:[{ role:'user', content:gptPrompt(pair,m,news,calendar,session) }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return extractJSON(d.choices?.[0]?.message?.content || '');
}

// ── HAUPT ROUTE: /analyze ──────────────────────────────────────
// Daten werden NUR 1x geholt → spart 66% Credits!
app.post('/analyze', async (req, res) => {
  try {
    const { pair, geminiKey, openaiKey, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());

    // ✅ NUR 1x Daten holen für ALLE KIs
    const [market, news, calendar] = await Promise.all([
      getLiveMarketData(pair, twelveKey),
      getLiveNews(pair, finnhubKey),
      getEconomicCalendar(finnhubKey)
    ]);

    // Alle KI Calls gleichzeitig mit denselben Daten
    const aiCalls = [
      callClaude(pair, market, news, calendar, session)
        .then(r => ({ ...r, ai:'claude', currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h, news:news.substring(0,120) }))
        .catch(e => ({ ai:'claude', error: e.message }))
    ];

    if (geminiKey) {
      aiCalls.push(
        callGemini(geminiKey, pair, market, news, calendar, session)
          .then(r => ({ ...r, ai:'gemini', currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h }))
          .catch(e => ({ ai:'gemini', error: e.message }))
      );
    }

    if (openaiKey) {
      aiCalls.push(
        callGPT(openaiKey, pair, market, news, calendar, session)
          .then(r => ({ ...r, ai:'openai', currentPrice:market.currentPrice, rsi:market.rsi }))
          .catch(e => ({ ai:'openai', error: e.message }))
      );
    }

    const results = await Promise.all(aiCalls);

    res.json({
      market: { currentPrice: market.currentPrice, rsi: market.rsi, ema20: market.ema20, ema50_4h: market.ema50_4h },
      news,
      calendar,
      results
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ALTE ROUTEN (Rückwärtskompatibilität) ─────────────────────
app.post('/marketdata', async (req, res) => {
  try {
    const { pair, twelveKey } = req.body;
    res.json(await getLiveMarketData(pair, twelveKey));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/claude', async (req, res) => {
  try {
    const { pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, news, calendar] = await Promise.all([getLiveMarketData(pair,twelveKey), getLiveNews(pair,finnhubKey), getEconomicCalendar(finnhubKey)]);
    const result = await callClaude(pair, market, news, calendar, session);
    res.json({ ...result, currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h, news:news.substring(0,120) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/gemini', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, news, calendar] = await Promise.all([getLiveMarketData(pair,twelveKey), getLiveNews(pair,finnhubKey), getEconomicCalendar(finnhubKey)]);
    const result = await callGemini(key, pair, market, news, calendar, session);
    res.json({ ...result, currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/openai', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, news, calendar] = await Promise.all([getLiveMarketData(pair,twelveKey), getLiveNews(pair,finnhubKey), getEconomicCalendar(finnhubKey)]);
    const result = await callGPT(key, pair, market, news, calendar, session);
    res.json({ ...result, currentPrice:market.currentPrice, rsi:market.rsi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY v5.0 — OPTIMIZED'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
