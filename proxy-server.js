const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Claude Proxy
app.post('/claude', async (req, res) => {
  try {
    const { pair } = req.body;
    const now = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: `Forex-Analyst: Analysiere ${pair} (${now}). Beachte: Trend, Fed/EZB/BoJ, Geopolitik Iran. NUR JSON ohne Backticks: {"signal":"BUY oder SELL oder NEUTRAL","entry":"1.1620","sl":"1.1580","tp":"1.1700","confidence":7,"reason":"2-3 Sätze Deutsch"}` }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gemini Proxy
app.post('/gemini', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const now = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
    const prompt = `Du bist Forex-Analyst. Analysiere ${pair} für ${now}. Beachte Trend, Fed/EZB/BoJ Politik, Iran-Geopolitik. Antworte NUR mit diesem JSON ohne Backticks: {"signal":"BUY oder SELL oder NEUTRAL","entry":"1.1620","sl":"1.1580","tp":"1.1700","confidence":7,"reason":"2-3 Sätze auf Deutsch"}`;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }) }
    );
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// OpenAI Proxy
app.post('/openai', async (req, res) => {
  try {
    const { key, pair } = req.body;
    const now = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 500, messages: [{ role: 'user', content: `Forex-Analyst: Analysiere ${pair} (${now}). NUR JSON ohne Backticks: {"signal":"BUY oder SELL oder NEUTRAL","entry":"1.1620","sl":"1.1580","tp":"1.1700","confidence":7,"reason":"2-3 Sätze Deutsch"}` }] })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(JSON.parse(data.choices?.[0]?.message?.content?.replace(/```json|```/g, '').trim()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY ONLINE'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
