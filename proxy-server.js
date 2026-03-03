const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

// Robuster JSON Parser
function parseAIResponse(text) {
  // Schritt 1: Backticks und json-Tag entfernen
  let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
  // Schritt 2: Ersten { bis letzten } extrahieren
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Kein JSON gefunden in: ' + clean.substring(0, 80));
  const jsonStr = clean.substring(start, end + 1);
  return JSON.parse(jsonStr);
}

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
  const date = now.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const session = getSession(now.getUTCHours());
  return `Du bist Forex-Analyst. Analysiere ${pair} fuer ${date} (${session} Session). Beachte: 4H Trend, 15min Einstieg, Fed/EZB/BoJ, Iran-Geopolitik. Antworte NUR mit diesem JSON ohne Backticks oder sonstigen Text: {"signal":"BUY oder SELL oder NEUTRAL","entry":"1.08450","sl":"1.08300","tp":"1.08650","confidence":7,"reason":"2 Saetze Deutsch"}`;
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
    res.json(parseAIResponse(text));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/gemini', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: getGeminiPrompt(pair) }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1024 } })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json(parseAIResponse(text));
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
    res.json(parseAIResponse(content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY v2.0 — SCALPING MODE'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
