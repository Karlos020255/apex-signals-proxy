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

function getClaudePrompt(pair) {
  const now = new Date();
  const time = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const session = getSession(now.getUTCHours());
  return `Du bist Senior Forex Makro-Analyst (Goldman Sachs, 20 Jahre Erfahrung).
Zeit: ${time} | Datum: ${date} | Session: ${session} | Pair: ${pair}

SPEZIALISIERUNG: Makroökonomie, Zentralbank-Politik, Geopolitik, Fundamentalanalyse.

Analysiere ${pair} auf Basis von:
1. ZENTRALBANK DIVERGENZ: Welche CB ist hawkisher? Aktueller Zinsentscheid-Ausblick?
2. GEOPOLITIK: Iran, Ukraine, Naher Osten - USD Safe Haven Nachfrage?
3. WIRTSCHAFTSDATEN: Letzte CPI/NFP/BIP Daten und Auswirkung auf ${pair}
4. 4H TREND: Übergeordneter Trend - ist er klar definiert?
5. 15MIN SCALP: Ist jetzt ein guter Einstieg IM 4H Trend?
6. SESSION: Ist ${session} optimal für ${pair}?

REGELN: SL max 15 Pips, TP min 1:2 RRR, nur MIT 4H Trend, bei ASIEN Session NEUTRAL bevorzugen.

NUR JSON ohne Backticks: {"signal":"BUY oder SELL oder NEUTRAL","entry":"Preis","sl":"SL Preis","tp":"TP Preis","confidence":8,"reason":"2-3 Sätze: CB-Divergenz + 4H Trend + 15min Setup auf Deutsch"}`;
}

function getGeminiPrompt(pair) {
  const now = new Date();
  const time = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const session = getSession(now.getUTCHours());
  return `Du bist professioneller technischer Analyst - Price Action und Smart Money Concepts Experte.
Zeit: ${time} | Datum: ${date} | Session: ${session} | Pair: ${pair}

SPEZIALISIERUNG: Price Action, SMC, Chartmuster, Key Levels, EMA Analyse.

Analysiere ${pair} auf Basis von:
1. 4H STRUKTUR: HH/LL Struktur, Trend-Richtung, wichtige S/R Zones
2. 15MIN PRICE ACTION: Kerzenformation, BoS, CHoCH, Engulfing
3. KEY LEVELS: Nächste kritische Unterstützung und Widerstand in Pips
4. EMA CONFLUENCE: EMA 20/50/200 Stack auf 15min UND 4H ausgerichtet?
5. MOMENTUM: RSI Position, Divergenz vorhanden?
6. LIQUIDITY: Wo liegen Stop-Cluster? Fair Value Gaps?

REGELN: SL hinter Key Level (max 15 Pips), TP zur Liquiditätszone (min 1:2 RRR), Einstieg nach Kerzenbestätigung.

NUR JSON ohne Backticks: {"signal":"BUY oder SELL oder NEUTRAL","entry":"Preis","sl":"SL hinter Key Level","tp":"Liquiditätszone als TP","confidence":8,"reason":"2-3 Sätze: 4H Struktur + 15min Setup + konkretes Level auf Deutsch"}`;
}

function getGPTPrompt(pair) {
  const now = new Date();
  const time = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const session = getSession(now.getUTCHours());
  return `Du bist quantitativer Forex-Trader mit Expertise in Sentiment, News-Trading und Intermarket-Analyse.
Zeit: ${time} | Datum: ${date} | Session: ${session} | Pair: ${pair}

SPEZIALISIERUNG: Marktsentiment, News-Impact, COT-Daten, Intermarket-Korrelationen.

Analysiere ${pair} auf Basis von:
1. SENTIMENT: Risk-on oder Risk-off? DXY Stärke/Schwäche?
2. NEWS: Welche roten Events auf Forex Factory beeinflussen ${pair} heute?
3. COT DATEN: Großspekulanten Long oder Short positioniert?
4. INTERMARKET: Korrelation mit SPX, Gold, Öl, Anleihenrenditen
5. 4H+15MIN CONFLUENCE: Trendstärke auf beiden Timeframes übereinstimmend?
6. SMART MONEY: Wo sind Retail-Stops? Contrarian Perspektive?

REGELN: Kein Trade 30min vor roten News, SL max 15 Pips, TP 1:2 bis 1:3 RRR.

NUR JSON ohne Backticks: {"signal":"BUY oder SELL oder NEUTRAL","entry":"Preis","sl":"SL Preis","tp":"TP Preis","confidence":8,"reason":"2-3 Sätze: Sentiment + News-Impact + 4H/15min Confluence auf Deutsch"}`;
}

app.post('/claude', async (req, res) => {
  try {
    const { pair } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: getClaudePrompt(pair) }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    const cmatch = text.match(/{[\s\S]*}/);
    if (!cmatch) return res.status(500).json({ error: 'Kein JSON in Claude Antwort' });
    res.json(JSON.parse(cmatch[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/gemini', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: getGeminiPrompt(pair) }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 600 } })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const gmatch = text.match(/{[\s\S]*}/);
    if (!gmatch) return res.status(500).json({ error: 'Kein JSON in Gemini Antwort' });
    res.json(JSON.parse(gmatch[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/openai', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 600, messages: [{ role: 'user', content: getGPTPrompt(pair) }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const content = data.choices?.[0]?.message?.content || '';
    const omatch = content.match(/{[\s\S]*}/);
    if (!omatch) return res.status(500).json({ error: 'Kein JSON in OpenAI Antwort' });
    res.json(JSON.parse(omatch[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY v2.0 — SCALPING MODE'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
