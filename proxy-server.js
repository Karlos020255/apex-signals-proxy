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

// CLAUDE — Makro + Fundamentals + Geopolitik
function claudePrompt(pair) {
  const d = new Date();
  const date = d.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const session = getSession(d.getUTCHours());
  return `Forex Makro-Analyst. Pair: ${pair}. Datum: ${date}. Session: ${session}.
Analysiere: Zentralbank-Divergenz (Fed/EZB/BoE/BoJ), Geopolitik Iran/Ukraine, 4H Trend, 15min Scalp-Einstieg.
Regeln: SL max 15 Pips, TP min 1:2 RRR, nur MIT 4H Trend.
Antworte NUR mit JSON (kein Markdown, keine Erklaerung):
{"signal":"BUY","entry":"1.08450","sl":"1.08300","tp":"1.08750","confidence":7,"reason":"2 Saetze Deutsch"}`;
}

// GEMINI — Technische Analyse + Price Action
function geminiPrompt(pair) {
  const d = new Date();
  const date = d.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const session = getSession(d.getUTCHours());
  return `Forex technischer Analyst. Pair: ${pair}. Datum: ${date}. Session: ${session}.
Analysiere: EMA 20/50/200 auf 4H und 15min, Key Levels, Price Action, RSI, Break of Structure.
Regeln: SL hinter Key Level max 15 Pips, TP Liquiditaetszone min 1:2 RRR.
Antworte NUR mit JSON (kein Markdown, keine Erklaerung):
{"signal":"BUY","entry":"1.08450","sl":"1.08300","tp":"1.08750","confidence":7,"reason":"2 Saetze Deutsch"}`;
}

// GPT-4 — Sentiment + News + Intermarket
function gptPrompt(pair) {
  const d = new Date();
  const date = d.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const session = getSession(d.getUTCHours());
  return `Forex Sentiment-Analyst. Pair: ${pair}. Datum: ${date}. Session: ${session}.
Analysiere: Risk-on/off, DXY, COT Daten, News Impact, Intermarket (Gold/Oel/Anleihen), 4H+15min Confluence.
Regeln: Kein Trade vor roten News, SL max 15 Pips, TP 1:2 bis 1:3 RRR.
Antworte NUR mit JSON (kein Markdown, keine Erklaerung):
{"signal":"BUY","entry":"1.08450","sl":"1.08300","tp":"1.08750","confidence":7,"reason":"2 Saetze Deutsch"}`;
}

// CLAUDE ROUTE
app.post('/claude', async (req, res) => {
  try {
    const { pair } = req.body;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: claudePrompt(pair) }] })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json(extractJSON(d.content?.[0]?.text || ''));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GEMINI ROUTE
app.post('/gemini', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: geminiPrompt(pair) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500, responseMimeType: "application/json" }
      })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json(extractJSON(text));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OPENAI ROUTE
app.post('/openai', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [{ role: 'user', content: gptPrompt(pair) }]
      })
    });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json(extractJSON(d.choices?.[0]?.message?.content || ''));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY v3.0'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
