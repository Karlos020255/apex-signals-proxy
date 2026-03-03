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

// Forex Pair zu Twelve Data Symbol konvertieren
function toTwelveSymbol(pair) {
  return pair.replace('/', '');
}

// Live Marktdaten von Twelve Data holen
async function getLiveMarketData(pair, twelveKey) {
  try {
    const symbol = toTwelveSymbol(pair);

    // 15min Kerzen (letzte 20)
    const r15 = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=15min&outputsize=20&apikey=${twelveKey}`);
    const d15 = await r15.json();

    // 4H Kerzen (letzte 10)
    const r4h = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=4h&outputsize=10&apikey=${twelveKey}`);
    const d4h = await r4h.json();

    // RSI 14 auf 15min
    const rRSI = await fetch(`https://api.twelvedata.com/rsi?symbol=${symbol}&interval=15min&time_period=14&outputsize=1&apikey=${twelveKey}`);
    const dRSI = await rRSI.json();

    // EMA 20 auf 15min
    const rEMA20 = await fetch(`https://api.twelvedata.com/ema?symbol=${symbol}&interval=15min&time_period=20&outputsize=1&apikey=${twelveKey}`);
    const dEMA20 = await rEMA20.json();

    // EMA 50 auf 4H
    const rEMA50 = await fetch(`https://api.twelvedata.com/ema?symbol=${symbol}&interval=4h&time_period=50&outputsize=1&apikey=${twelveKey}`);
    const dEMA50 = await rEMA50.json();

    const candles15 = d15.values ? d15.values.slice(0, 5).map(c => `${c.datetime} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | ') : 'N/A';
    const candles4h  = d4h.values ? d4h.values.slice(0, 3).map(c => `${c.datetime} O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | ') : 'N/A';
    const currentPrice = d15.values ? d15.values[0].close : 'N/A';
    const rsi = dRSI.values ? dRSI.values[0].rsi : 'N/A';
    const ema20 = dEMA20.values ? dEMA20.values[0].ema : 'N/A';
    const ema50_4h = dEMA50.values ? dEMA50.values[0].ema : 'N/A';

    return { currentPrice, candles15, candles4h, rsi, ema20, ema50_4h };
  } catch(e) {
    return { currentPrice: 'N/A', candles15: 'N/A', candles4h: 'N/A', rsi: 'N/A', ema20: 'N/A', ema50_4h: 'N/A' };
  }
}

// Live News von Finnhub holen
async function getLiveNews(pair, finnhubKey) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=forex&token=${finnhubKey}`);
    const news = await r.json();
    const currencies = pair.split('/');
    const relevant = news
      .filter(n => currencies.some(c => n.headline.includes(c) || n.summary.includes(c)))
      .slice(0, 3)
      .map(n => n.headline)
      .join(' | ');
    return relevant || 'Keine aktuellen News gefunden';
  } catch(e) {
    return 'News nicht verfuegbar';
  }
}

// Wirtschaftskalender von Finnhub
async function getEconomicCalendar(finnhubKey) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${finnhubKey}`);
    const d = await r.json();
    const highImpact = d.economicCalendar
      ? d.economicCalendar.filter(e => e.impact === 'high').slice(0, 5).map(e => `${e.time} ${e.country} ${e.event}`).join(' | ')
      : 'Keine High-Impact Events heute';
    return highImpact;
  } catch(e) {
    return 'Kalender nicht verfuegbar';
  }
}

// CLAUDE PROMPT mit Live-Daten
function claudePrompt(pair, market, news, calendar, session) {
  return `Du bist Senior Forex Makro-Analyst (Goldman Sachs, 20 Jahre).
Pair: ${pair} | Session: ${session}

LIVE MARKTDATEN:
- Aktueller Preis: ${market.currentPrice}
- RSI (14, 15min): ${market.rsi}
- EMA 20 (15min): ${market.ema20}
- EMA 50 (4H): ${market.ema50_4h}
- Letzte 15min Kerzen: ${market.candles15}
- Letzte 4H Kerzen: ${market.candles4h}

AKTUELLE NEWS: ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

Analysiere mit Fokus auf:
1. Zentralbank-Divergenz (Fed/EZB/BoE/BoJ)
2. Geopolitik + USD Safe-Haven
3. 4H Trend basierend auf echten Kerzen
4. 15min Scalp-Einstieg basierend auf echten Daten
5. News-Impact auf ${pair}

Regeln: SL max 15 Pips, TP min 1:2 RRR, nur MIT 4H Trend, bei High-Impact Events NEUTRAL.
Antworte NUR mit JSON (kein Markdown):
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${market.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch mit Bezug auf echte Daten"}`;
}

// GEMINI PROMPT mit Live-Daten
function geminiPrompt(pair, market, news, calendar, session) {
  return `Forex technischer Analyst. Pair: ${pair} | Session: ${session}

LIVE MARKTDATEN:
- Aktueller Preis: ${market.currentPrice}
- RSI (14, 15min): ${market.rsi}
- EMA 20 (15min): ${market.ema20}
- EMA 50 (4H): ${market.ema50_4h}
- Letzte 15min Kerzen: ${market.candles15}
- Letzte 4H Kerzen: ${market.candles4h}

AKTUELLE NEWS: ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

Analysiere: EMA Stack 4H+15min, RSI Momentum, Key Levels aus echten Kerzen, Break of Structure.
Regeln: SL hinter Key Level max 15 Pips, TP Liquiditaetszone min 1:2 RRR, bei High-Impact Events NEUTRAL.
Antworte NUR mit JSON (kein Markdown):
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${market.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch mit Bezug auf echte Chartdaten"}`;
}

// GPT PROMPT mit Live-Daten
function gptPrompt(pair, market, news, calendar, session) {
  return `Forex Sentiment-Analyst. Pair: ${pair} | Session: ${session}

LIVE MARKTDATEN:
- Aktueller Preis: ${market.currentPrice}
- RSI (14, 15min): ${market.rsi}
- EMA 20 (15min): ${market.ema20}
- EMA 50 (4H): ${market.ema50_4h}
- Letzte 4H Kerzen: ${market.candles4h}

AKTUELLE NEWS: ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

Analysiere: Risk-on/off, DXY, COT Daten, News-Impact, Intermarket (Gold/Oel/Anleihen), 4H+15min Confluence.
Regeln: Kein Trade 30min vor roten Events, SL max 15 Pips, TP 1:2 bis 1:3 RRR.
Antworte NUR mit JSON (kein Markdown):
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${market.currentPrice}","sl":"Preis","tp":"Preis","confidence":8,"reason":"2-3 Saetze Deutsch mit News-Bezug"}`;
}

// CLAUDE ROUTE
app.post('/claude', async (req, res) => {
  try {
    const { pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, news, calendar] = await Promise.all([
      getLiveMarketData(pair, twelveKey),
      getLiveNews(pair, finnhubKey),
      getEconomicCalendar(finnhubKey)
    ]);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: claudePrompt(pair, market, news, calendar, session) }] })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    const result = extractJSON(d.content?.[0]?.text || '');
    result.currentPrice = market.currentPrice;
    result.rsi = market.rsi;
    result.news = news.substring(0, 100);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GEMINI ROUTE
app.post('/gemini', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, news, calendar] = await Promise.all([
      getLiveMarketData(pair, twelveKey),
      getLiveNews(pair, finnhubKey),
      getEconomicCalendar(finnhubKey)
    ]);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: geminiPrompt(pair, market, news, calendar, session) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 600, responseMimeType: "application/json" }
      })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const result = extractJSON(text);
    result.currentPrice = market.currentPrice;
    result.rsi = market.rsi;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OPENAI ROUTE
app.post('/openai', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, news, calendar] = await Promise.all([
      getLiveMarketData(pair, twelveKey),
      getLiveNews(pair, finnhubKey),
      getEconomicCalendar(finnhubKey)
    ]);
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [{ role: 'user', content: gptPrompt(pair, market, news, calendar, session) }]
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

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY v4.0 — LIVE DATA MODE'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
