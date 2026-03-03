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

function toTwelveSymbol(pair) {
  return pair.replace('/', '');
}

// NUR 2 API Calls statt 5 - spart Credits!
async function getLiveMarketData(pair, twelveKey) {
  if (!twelveKey) return { currentPrice:'N/A', candles15:'N/A', candles4h:'N/A', rsi:'N/A', ema20:'N/A', ema50_4h:'N/A' };
  try {
    const symbol = toTwelveSymbol(pair);

    // Call 1: 15min Kerzen mit Indikatoren (1 Credit)
    const r15 = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=15min&outputsize=20&apikey=${twelveKey}`);
    const d15 = await r15.json();

    // Call 2: 4H Kerzen (1 Credit)
    const r4h = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=4h&outputsize=10&apikey=${twelveKey}`);
    const d4h = await r4h.json();

    if (!d15.values || !d4h.values) {
      return { currentPrice:'N/A', candles15:'N/A', candles4h:'N/A', rsi:'N/A', ema20:'N/A', ema50_4h:'N/A' };
    }

    // RSI manuell berechnen aus 15min Kerzen
    const closes15 = d15.values.map(c => parseFloat(c.close)).reverse();
    const gains = [], losses = [];
    for (let i = 1; i < closes15.length; i++) {
      const diff = closes15[i] - closes15[i-1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    const avgGain = gains.slice(-14).reduce((a,b)=>a+b,0)/14;
    const avgLoss = losses.slice(-14).reduce((a,b)=>a+b,0)/14;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = (100 - (100/(1+rs))).toFixed(2);

    // EMA 20 manuell aus 15min Kerzen
    const k20 = 2/(20+1);
    let ema20 = parseFloat(closes15[0]);
    for (let i = 1; i < Math.min(closes15.length, 20); i++) {
      ema20 = closes15[i] * k20 + ema20 * (1-k20);
    }

    // EMA 50 aus 4H Kerzen
    const closes4h = d4h.values.map(c => parseFloat(c.close)).reverse();
    const k50 = 2/(50+1);
    let ema50 = parseFloat(closes4h[0]);
    for (let i = 1; i < closes4h.length; i++) {
      ema50 = closes4h[i] * k50 + ema50 * (1-k50);
    }

    const currentPrice = d15.values[0].close;
    const candles15 = d15.values.slice(0,5).map(c=>`${c.datetime.split(' ')[1]} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | ');
    const candles4h  = d4h.values.slice(0,3).map(c=>`${c.datetime.split(' ')[0]} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | ');

    return {
      currentPrice,
      candles15,
      candles4h,
      rsi: rsi.toString(),
      ema20: ema20.toFixed(5),
      ema50_4h: ema50.toFixed(5)
    };
  } catch(e) {
    return { currentPrice:'N/A', candles15:'N/A', candles4h:'N/A', rsi:'N/A', ema20:'N/A', ema50_4h:'N/A' };
  }
}

// News von Finnhub
async function getLiveNews(pair, finnhubKey) {
  if (!finnhubKey) return 'Kein Finnhub Key';
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=forex&token=${finnhubKey}`);
    const news = await r.json();
    if (!Array.isArray(news)) return 'Keine News verfuegbar';
    const currencies = pair.split('/');
    const relevant = news
      .filter(n => currencies.some(c => (n.headline||'').includes(c) || (n.summary||'').includes(c)))
      .slice(0, 3)
      .map(n => n.headline)
      .join(' | ');
    return relevant || 'Keine relevanten News gefunden';
  } catch(e) {
    return 'News nicht verfuegbar';
  }
}

// Wirtschaftskalender
async function getEconomicCalendar(finnhubKey) {
  if (!finnhubKey) return 'Kein Finnhub Key';
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${finnhubKey}`);
    const d = await r.json();
    const events = d.economicCalendar || [];
    const highImpact = events
      .filter(e => e.impact === 'high')
      .slice(0, 5)
      .map(e => `${e.time||''} ${e.country||''} ${e.event||''}`)
      .join(' | ');
    return highImpact || 'Keine High-Impact Events heute';
  } catch(e) {
    return 'Kalender nicht verfuegbar';
  }
}

// SHARED: Alle Daten auf einmal holen (wird gecacht pro Request)
async function getAllData(pair, twelveKey, finnhubKey) {
  const [market, news, calendar] = await Promise.all([
    getLiveMarketData(pair, twelveKey),
    getLiveNews(pair, finnhubKey),
    getEconomicCalendar(finnhubKey)
  ]);
  return { market, news, calendar };
}

function claudePrompt(pair, market, news, calendar, session) {
  return `Du bist Senior Forex Makro-Analyst (Goldman Sachs, 20 Jahre).
Pair: ${pair} | Session: ${session}

LIVE MARKTDATEN (Twelve Data):
- Aktueller Preis: ${market.currentPrice}
- RSI 14 (15min): ${market.rsi}
- EMA 20 (15min): ${market.ema20}
- EMA 50 (4H): ${market.ema50_4h}
- 15min Kerzen: ${market.candles15}
- 4H Kerzen: ${market.candles4h}

AKTUELLE NEWS: ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

Analysiere:
1. Zentralbank-Divergenz (Fed/EZB/BoE/BoJ) basierend auf aktuellem Kontext
2. Geopolitik + USD Safe-Haven Nachfrage
3. 4H Trend aus echten Kerzen: Bullish oder Bearish?
4. 15min Scalp-Einstieg: Passt zur 4H Richtung?
5. News-Impact: Stuetzt oder widerspricht die News dem Signal?

Regeln: SL max 15 Pips vom Entry, TP min 1:2 RRR, bei High-Impact Events innerhalb 30min -> NEUTRAL.
Antworte NUR mit JSON ohne Markdown:
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${market.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch mit echten Datenbezug"}`;
}

function geminiPrompt(pair, market, news, calendar, session) {
  return `Forex technischer Analyst. Pair: ${pair} | Session: ${session}

LIVE MARKTDATEN (Twelve Data):
- Aktueller Preis: ${market.currentPrice}
- RSI 14 (15min): ${market.rsi}
- EMA 20 (15min): ${market.ema20}
- EMA 50 (4H): ${market.ema50_4h}
- 15min Kerzen: ${market.candles15}
- 4H Kerzen: ${market.candles4h}

AKTUELLE NEWS: ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

Analysiere: EMA Stack 4H+15min bullish/bearish, RSI Momentum, Price Action aus echten Kerzen, Key Levels.
Regeln: SL hinter letztem Swing max 15 Pips, TP naechste Liquiditaetszone min 1:2 RRR.
Antworte NUR mit JSON ohne Markdown:
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${market.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch mit echten Chartdaten"}`;
}

function gptPrompt(pair, market, news, calendar, session) {
  return `Forex Sentiment-Analyst. Pair: ${pair} | Session: ${session}

LIVE MARKTDATEN (Twelve Data):
- Aktueller Preis: ${market.currentPrice}
- RSI 14 (15min): ${market.rsi}
- EMA 50 (4H): ${market.ema50_4h}
- 4H Kerzen: ${market.candles4h}

AKTUELLE NEWS: ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

Analysiere: Risk-on/off Umfeld, DXY Staerke/Schwaeche, News-Sentiment fuer ${pair}, 4H+15min Momentum.
Regeln: Kein Trade 30min vor High-Impact Events, SL max 15 Pips, TP 1:2 bis 1:3 RRR.
Antworte NUR mit JSON ohne Markdown:
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${market.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch mit News und Sentiment Bezug"}`;
}

// MARKETDATA ROUTE
app.post('/marketdata', async (req, res) => {
  try {
    const { pair, twelveKey } = req.body;
    const data = await getLiveMarketData(pair, twelveKey);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CLAUDE ROUTE
app.post('/claude', async (req, res) => {
  try {
    const { pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const { market, news, calendar } = await getAllData(pair, twelveKey, finnhubKey);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.CLAUDE_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:600, messages:[{ role:'user', content:claudePrompt(pair,market,news,calendar,session) }] })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    const result = extractJSON(d.content?.[0]?.text || '');
    result.currentPrice = market.currentPrice;
    result.rsi = market.rsi;
    result.ema20 = market.ema20;
    result.ema50_4h = market.ema50_4h;
    result.news = news.substring(0, 120);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GEMINI ROUTE
app.post('/gemini', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const { market, news, calendar } = await getAllData(pair, twelveKey, finnhubKey);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: geminiPrompt(pair,market,news,calendar,session) }] }],
        generationConfig: { temperature:0.1, maxOutputTokens:600, responseMimeType:"application/json" }
      })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const result = extractJSON(text);
    result.currentPrice = market.currentPrice;
    result.rsi = market.rsi;
    result.ema20 = market.ema20;
    result.ema50_4h = market.ema50_4h;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OPENAI ROUTE
app.post('/openai', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const { market, news, calendar } = await getAllData(pair, twelveKey, finnhubKey);
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}` },
      body: JSON.stringify({
        model:'gpt-4o', max_tokens:600,
        response_format: { type:"json_object" },
        messages:[{ role:'user', content:gptPrompt(pair,market,news,calendar,session) }]
      })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    const result = extractJSON(d.choices?.[0]?.message?.content || '');
    result.currentPrice = market.currentPrice;
    result.rsi = market.rsi;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY v4.1 — LIVE DATA MODE'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
