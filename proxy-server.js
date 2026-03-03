const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

function getScalpingPrompt(pair) {
  const now = new Date();
  const time = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
  const hour = now.getUTCHours();
  const session = hour >= 7 && hour < 12 ? "LONDON SESSION" : hour >= 12 && hour < 17 ? "NEW YORK SESSION" : hour >= 17 && hour < 21 ? "LONDON/NY OVERLAP" : "ASIEN SESSION";

  return `Du bist ein professioneller Forex Scalping-Trader mit 15 Jahren Erfahrung.
Aktuelle Zeit: ${time} Uhr (${date}) — Aktive Session: ${session}

Analysiere ${pair} für SCALPING auf dem 15-MINUTEN CHART.

Berücksichtige:
1. 15min Marktstruktur (Higher High/Lower Low, Break of Structure)
2. Aktuelle Session-Liquidität (${session})
3. Wichtige Intraday Key Levels (vorheriges High/Low, Round Numbers)
4. Momentum und aktuelle Kerzenformation
5. Makro-Kontext: Fed/EZB/BoJ, Iran-Geopolitik, USD-Stärke
6. Spread und Slippage einkalkulieren

SCALPING REGELN:
- Stop Loss: maximal 15-20 Pips
- Take Profit: mindestens 1:1.5 RRR
- Bei ASIEN SESSION wenig Volumen → NEUTRAL bevorzugen

Antworte NUR mit diesem JSON ohne Backticks:
{"signal":"BUY oder SELL oder NEUTRAL","entry":"1.08450","sl":"1.08300","tp":"1.08650","confidence":7,"reason":"2-3 präzise Sätze auf Deutsch"}`;
}

// Claude Proxy
app.post('/claude', async (req, res) => {
  try {
    const { pair } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: getScalpingPrompt(pair) }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Gemini Proxy
app.post('/gemini', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: getScalpingPrompt(pair) }] }], generationConfig: { temperature: 0.2 } })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OpenAI Proxy
app.post('/openai', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 600, messages: [{ role: 'user', content: getScalpingPrompt(pair) }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(JSON.parse(data.choices?.[0]?.message?.content?.replace(/```json|```/g, '').trim()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY — SCALPING MODE ACTIVE'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
