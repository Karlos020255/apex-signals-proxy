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
const USD_PAIRS = ['EUR/USD','GBP/USD','AUD/USD','NZD/USD','XAU/USD'];

function scoreHeadline(h, base, quote, pair) {
  const BULL = ['surge','rally','rise','gain','strong','hawkish','hike','beat','better','growth','optimism','boost','upgrade','soar','jump','recover'];
  const BEAR = ['fall','drop','decline','weak','dovish','cut','miss','worse','recession','concern','downgrade','crash','slump','tumble','slide'];
  const usdIsQuote = USD_PAIRS.includes(pair);
  const text = h.toLowerCase();
  let score = 0;

  const hasBase = text.includes(base.toLowerCase()) ||
    (base==='EUR' && (text.includes('euro')||text.includes('ecb'))) ||
    (base==='GBP' && (text.includes('pound')||text.includes('sterling')||text.includes('boe'))) ||
    (base==='JPY' && (text.includes('yen')||text.includes('boj'))) ||
    (base==='AUD' && (text.includes('aussie')||text.includes('rba'))) ||
    (base==='XAU' && text.includes('gold'));
  const hasUSD = text.includes('usd')||text.includes('dollar')||text.includes('fed')||text.includes('federal reserve');

  BULL.forEach(w => {
    if (text.includes(w)) {
      if (hasBase) score += 1;
      if (hasUSD && usdIsQuote) score -= 1;
    }
  });
  BEAR.forEach(w => {
    if (text.includes(w)) {
      if (hasBase) score -= 1;
      if (hasUSD && usdIsQuote) score += 1;
    }
  });
  return score;
}

async function getLiveNews(pair, finnhubKey) {
  if (!finnhubKey) return { text: 'Kein Finnhub Key', sentiment: 'UNBEKANNT', score: '0' };
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=forex&token=${finnhubKey}`);
    const news = await r.json();
    if (!Array.isArray(news) || news.length === 0) {
      return { text: 'Keine News verfuegbar', sentiment: 'UNBEKANNT', score: '0' };
    }
    const [base, quote] = pair.split('/');
    const keywords = [base, quote, 'fed','ecb','boe','boj','dollar','euro','pound','yen','forex','rate','inflation'].map(k=>k.toLowerCase());
    
    const relevant = news.filter(n => {
      const h = (n.headline||'').toLowerCase();
      return keywords.some(k => h.includes(k));
    }).slice(0, 6);

    const toUse = relevant.length > 0 ? relevant : news.slice(0, 3);
    
    const scored = toUse.map(n => {
      const s = scoreHeadline(n.headline, base, quote, pair);
      const sentiment = s > 0.5 ? 'BULLISH' : s < -0.5 ? 'BEARISH' : 'NEUTRAL';
      return { headline: n.headline, sentiment, score: s };
    });

    const avg = scored.reduce((a,b) => a + b.score, 0) / scored.length;
    const overall = avg > 0.4 ? 'BULLISH' : avg < -0.4 ? 'BEARISH' : 'NEUTRAL';
    const topText = scored.slice(0,3).map(n => `[${n.sentiment}] ${n.headline}`).join(' || ');

    return { text: topText, sentiment: overall, score: avg.toFixed(1) };
  } catch(e) {
    return { text: 'News nicht verfuegbar', sentiment: 'UNBEKANNT', score: '0' };
  }
}

async function getEconomicCalendar(finnhubKey) {
  try {
    // Forexfactory öffentlicher Kalender als JSON (kostenlos, keine API nötig)
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth()+1).padStart(2,'0');
    const dd = String(today.getUTCDate()).padStart(2,'0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    // Fallback: Finnhub versuchen
    if (finnhubKey) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${dateStr}&to=${dateStr}&token=${finnhubKey}`);
        const d = await r.json();
        // Finnhub gibt verschiedene Feldnamen zurück - alles prüfen
        const raw = d.economicCalendar || d.economic_calendar || d.data || d.result || [];
        if (Array.isArray(raw) && raw.length > 0) {
          const highImpact = raw
            .filter(e => {
              const imp = (e.impact||e.importance||'').toString().toLowerCase();
              return imp === 'high' || imp === '3' || imp === 'red';
            })
            .slice(0,5)
            .map(e => {
              const time = e.time || e.datetime || '';
              const country = e.country || e.unit || '';
              const event = e.event || e.name || e.indicator || '';
              return `${time} ${country} ${event}`.trim();
            })
            .filter(s => s.length > 2)
            .join(' | ');
          if (highImpact) return highImpact;
        }
      } catch(fe) {}
    }

    // Fallback: Bekannte High-Impact Events heute manuell einschätzen
    const hour = today.getUTCHours();
    const dayOfWeek = today.getUTCDay(); // 0=So, 1=Mo, 5=Fr
    
    // Freitag = NFP möglicher Tag (1. Freitag im Monat)
    if (dayOfWeek === 5 && parseInt(dd) <= 7) {
      // NFP ist immer 13:30 UTC
      const utcNow = today.getUTCHours() * 60 + today.getUTCMinutes();
      const nfpTime = 13 * 60 + 30; // 13:30 UTC
      const diff = utcNow - nfpTime; // positiv = nach NFP, negativ = vor NFP

      if (diff < -30) {
        return `${dateStr} 13:30 UTC USD Non-Farm Payrolls (HIGH IMPACT - in ${Math.abs(diff)} Minuten!)`;
      } else if (diff >= -30 && diff < 0) {
        return `${dateStr} 13:30 UTC USD Non-Farm Payrolls (HIGH IMPACT - in ${Math.abs(diff)} Minuten! Kein Trade!)`;
      } else if (diff >= 0 && diff < 15) {
        return `NFP gerade veröffentlicht (${diff} Min ago) - noch ${15-diff} Minuten warten!`;
      } else {
        return `NFP veröffentlicht um 13:30 UTC - Markt stabilisiert. Trading möglich.`;
      }
    }

    return 'Keine High-Impact Events heute - Trading möglich';
  } catch(e) { return 'Kalender temporär nicht verfuegbar'; }
}

// ── PROMPTS ────────────────────────────────────────────────────
function claudePrompt(pair, m, news, calendar, session) {
  const base = pair.split('/')[0];
  const quote = pair.split('/')[1];
  return `Du bist Senior Forex Makro-Analyst bei Goldman Sachs mit 20 Jahren Erfahrung.
Spezialisierung: Zentralbank-Politik, Makroökonomie, Geopolitik, 15min Scalping mit 4H Confluence.

PAIR: ${pair} | SESSION: ${session} | DATUM: ${new Date().toLocaleDateString('de-DE')}

LIVE MARKTDATEN (Twelve Data):
- Aktueller Preis: ${m.currentPrice}
- RSI 14 (15min): ${m.rsi} ${parseFloat(m.rsi) > 70 ? '← ÜBERKAUFT' : parseFloat(m.rsi) < 30 ? '← ÜBERVERKAUFT' : '← NEUTRAL'}
- EMA 20 (15min): ${m.ema20} ${parseFloat(m.currentPrice) > parseFloat(m.ema20) ? '← Preis ÜBER EMA20 (bullish)' : '← Preis UNTER EMA20 (bearish)'}
- EMA 50 (4H): ${m.ema50_4h} ${parseFloat(m.ema20) > parseFloat(m.ema50_4h) ? '← EMA20 > EMA50 (4H bullish)' : '← EMA20 < EMA50 (4H bearish)'}
- 15min Kerzen: ${m.candles15}
- 4H Kerzen: ${m.candles4h}

AKTUELLE NEWS (${base}/${quote}): ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

ANALYSE-AUFGABE:
1. ZENTRALBANK: Welche CB ist hawkisher? ${base} oder ${quote} CB aktueller Zinspfad?
2. GEOPOLITIK: USD Safe-Haven Nachfrage? Risikoumfeld?
3. 4H TREND: Aus den 4H Kerzen - klar bullish, bearish oder seitwärts?
4. 15MIN SETUP: EMA20 vs Preis, RSI Momentum - guter Scalp-Einstieg?
5. NEWS FILTER: Unterstützt die aktuelle News das Signal oder widerspricht sie?
6. SESSION CHECK: Ist ${session} optimal für ${pair}? (ASIEN = meistens NEUTRAL für EUR/GBP Paare)

STRIKTE REGELN:
- SL: max 15 Pips vom Entry
- TP: mindestens 1:2 RRR (also min 30 Pips bei 15 Pip SL)
- Bei High-Impact Events in nächsten 30min → IMMER NEUTRAL
- Nur MIT 4H Trend traden, NIEMALS dagegen
- Bei RSI > 70 → kein BUY, bei RSI < 30 → kein SELL

Berechne SL und TP als EXAKTE PREISZAHLEN:
- BUY: SL = Entry minus 10-15 Pips, TP = Entry plus 20-30 Pips (min 1:2 RRR)
- SELL: SL = Entry plus 10-15 Pips, TP = Entry minus 20-30 Pips (min 1:2 RRR)
- Bei NEUTRAL: sl = "0", tp = "0"
- Pips für JPY Paare = 0.10, für andere = 0.0010

Antworte NUR mit diesem JSON, kein Markdown, kein Text davor/danach:
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${m.currentPrice}","sl":"ZAHL wie 1.15450","tp":"ZAHL wie 1.16050","confidence":8,"reason":"3 präzise Sätze auf Deutsch: CB-Divergenz + 4H Trend + 15min Setup"}`;
}

function geminiPrompt(pair, m, news, calendar, session) {
  return `Du bist professioneller Forex Technischer Analyst mit Fokus auf Price Action und Smart Money Concepts.
Spezialisierung: EMA Analyse, RSI, Break of Structure, Liquiditätszonen, 15min Scalping mit 4H Confluence.

PAIR: ${pair} | SESSION: ${session}

LIVE MARKTDATEN (Twelve Data - echte Kerzen):
- Aktueller Preis: ${m.currentPrice}
- RSI 14 (15min): ${m.rsi} ${parseFloat(m.rsi) > 70 ? '← ÜBERKAUFT - kein BUY!' : parseFloat(m.rsi) < 30 ? '← ÜBERVERKAUFT - kein SELL!' : '← im Trading-Bereich'}
- EMA 20 (15min): ${m.ema20}
- EMA 50 (4H): ${m.ema50_4h}
- 15min Kerzen (neueste zuerst): ${m.candles15}
- 4H Kerzen (neueste zuerst): ${m.candles4h}

NEWS: ${news}
HIGH-IMPACT EVENTS: ${calendar}

DEINE AUFGABE - ENTSCHEIDE JETZT:
Preis ${m.currentPrice} | EMA20: ${m.ema20} | EMA50(4H): ${m.ema50_4h} | RSI: ${m.rsi}

ENTSCHEIDUNGSREGELN:
→ Preis > EMA20 > EMA50 UND RSI 40-65 = BUY
→ Preis < EMA20 < EMA50 UND RSI 35-60 = SELL  
→ EMA20 nahe EMA50 (weniger als 0.0005 Abstand) = NEUTRAL
→ RSI > 70 = kein BUY | RSI < 30 = kein SELL
→ High-Impact Event in weniger als 30min = NEUTRAL

WICHTIG: Bei klarem EMA Stack IMMER ein BUY oder SELL geben!
NEUTRAL nur wenn EMA Stack wirklich unklar oder High-Impact Event!

Berechne SL und TP als EXAKTE PREISZAHLEN basierend auf den Kerzen:
- BUY: SL = Entry minus 10-15 Pips, TP = Entry plus 20-30 Pips (1:2 RRR)
- SELL: SL = Entry plus 10-15 Pips, TP = Entry minus 20-30 Pips (1:2 RRR)
- Pips: JPY Paare = 0.10, alle anderen = 0.0010
- Bei NEUTRAL: sl = "0", tp = "0"

KONFIDENZ SKALA (sei ehrlich und präzise):
- 8-10: Alle Indikatoren eindeutig in eine Richtung
- 6-7: Mehrheit der Indikatoren zeigt Richtung
- 4-5: Gemischte Signale aber leichte Tendenz
- 1-3: Nur bei echtem NEUTRAL ohne klare Richtung

Antworte NUR mit diesem JSON, kein Markdown:
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${m.currentPrice}","sl":"ZAHL","tp":"ZAHL","confidence":7,"reason":"3 präzise Sätze auf Deutsch: EMA Stack + RSI + Price Action"}`;
}

function gptPrompt(pair, m, news, calendar, session) {
  const base = pair.split('/')[0];
  const quote = pair.split('/')[1];
  return `Du bist quantitativer Forex Sentiment-Analyst mit Fokus auf News-Trading und Intermarket-Analyse.
Spezialisierung: Marktsentiment, COT-Daten, News-Impact, DXY Korrelation, 15min Scalping.

PAIR: ${pair} | SESSION: ${session}

LIVE MARKTDATEN:
- Aktueller Preis: ${m.currentPrice}
- RSI 14 (15min): ${m.rsi}
- EMA 50 (4H): ${m.ema50_4h}
- 4H Kerzen: ${m.candles4h}

AKTUELLE NEWS: ${news}
HIGH-IMPACT EVENTS HEUTE: ${calendar}

DEINE AUFGABE - ENTSCHEIDE JETZT:
Preis: ${m.currentPrice} | RSI: ${m.rsi} | EMA50(4H): ${m.ema50_4h}
News: ${news}

ENTSCHEIDUNGSREGELN:
→ News BULLISH für ${base} + Preis über EMA50 = BUY
→ News BEARISH für ${base} + Preis unter EMA50 = SELL
→ News NEUTRAL aber Preis klar über/unter EMA50 → trotzdem BUY/SELL geben!
→ Kein High-Impact Event in 30min = NEUTRAL wegen Event
→ RSI > 75 = kein BUY | RSI < 25 = kein SELL

WICHTIG: Auch ohne eindeutige News IMMER eine Richtung wählen wenn 4H Trend klar!
NEUTRAL nur bei echtem High-Impact Event oder komplett widersprüchlichen Signalen!

Berechne SL und TP als EXAKTE PREISZAHLEN:
- BUY: SL = Entry minus 10-15 Pips, TP = Entry plus 20-30 Pips
- SELL: SL = Entry plus 10-15 Pips, TP = Entry minus 20-30 Pips
- Pips: JPY Paare = 0.10, alle anderen = 0.0010
- Bei NEUTRAL: sl = "0", tp = "0"

KONFIDENZ SKALA (sei präzise):
- 8-10: Klares Signal mit News + Trend + Momentum Bestätigung
- 6-7: Signal mit 2 von 3 Faktoren bestätigt
- 4-5: Leichte Tendenz erkennbar
- 1-3: Echtes NEUTRAL, keine Richtung erkennbar

Antworte NUR mit diesem JSON, kein Markdown:
{"signal":"BUY oder SELL oder NEUTRAL","entry":"${m.currentPrice}","sl":"ZAHL","tp":"ZAHL","confidence":7,"reason":"3 präzise Sätze auf Deutsch: News-Sentiment + Risk-Umfeld + 4H Confluence"}`;
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

    // NUR 1x Daten holen für ALLE KIs
    const [market, newsObj, calendar] = await Promise.all([
      getLiveMarketData(pair, twelveKey),
      getLiveNews(pair, finnhubKey),
      getEconomicCalendar(finnhubKey)
    ]);

    // News übersetzen via Claude
    async function translateNews(text) {
      if (!text || text.includes('Keine') || text.includes('verfuegbar')) return text;
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'x-api-key':process.env.CLAUDE_API_KEY, 'anthropic-version':'2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{ role: 'user', content: `Übersetze diese Forex News Headlines ins Deutsche. Behalte [BULLISH], [BEARISH], [NEUTRAL] Tags. Nur die Übersetzung, kein Zusatztext:
${text}` }]
          })
        });
        const d = await r.json();
        return d.content?.[0]?.text || text;
      } catch(e) { return text; }
    }

    const rawNewsDisplay = newsObj && newsObj.text ? newsObj.text : 'Keine News verfuegbar';
    const newsDisplay = await translateNews(rawNewsDisplay);
    const newsText = newsObj && newsObj.text 
      ? `${newsDisplay} | GESAMT-SENTIMENT: ${newsObj.sentiment} (Score: ${newsObj.score})`
      : 'Keine News verfuegbar | GESAMT-SENTIMENT: NEUTRAL (Score: 0)';

    // Alle KI Calls gleichzeitig mit denselben Daten
    const aiCalls = [
      callClaude(pair, market, newsText, calendar, session)
        .then(r => ({ ...r, ai:'claude', currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h, news:newsDisplay.substring(0,150) }))
        .catch(e => ({ ai:'claude', error: e.message }))
    ];

    if (geminiKey) {
      aiCalls.push(
        callGemini(geminiKey, pair, market, newsText, calendar, session)
          .then(r => ({ ...r, ai:'gemini', currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h }))
          .catch(e => ({ ai:'gemini', error: e.message }))
      );
    }

    if (openaiKey) {
      aiCalls.push(
        callGPT(openaiKey, pair, market, newsText, calendar, session)
          .then(r => ({ ...r, ai:'openai', currentPrice:market.currentPrice, rsi:market.rsi }))
          .catch(e => ({ ai:'openai', error: e.message }))
      );
    }

    const rawResults = await Promise.all(aiCalls);

    // KONFIDENZ-FILTER: Nur sehr schwache Signale (unter 4/10) filtern
    // Gemini und GPT tendieren zu niedrigeren Werten → Filter nicht zu streng
    const results = rawResults.map(r => {
      if (r.error) return r;
      const conf = parseInt(r.confidence) || 0;
      if (r.signal !== 'NEUTRAL' && conf < 4) {
        return {
          ...r,
          signal: 'NEUTRAL',
          originalSignal: r.signal,
          filteredBy: 'KONFIDENZ',
          reason: `[FILTER ${conf}/10 < 4/10] ${r.reason}`
        };
      }
      return r;
    });

    const newsSentiment = (newsObj && newsObj.sentiment) ? newsObj.sentiment : 'NEUTRAL';
    const newsScore = (newsObj && newsObj.score) ? newsObj.score : '0';

    res.json({
      market: { currentPrice: market.currentPrice, rsi: market.rsi, ema20: market.ema20, ema50_4h: market.ema50_4h },
      news: newsDisplay,
      newsSentiment,
      newsScore,
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
    const [market, newsObj, calendar] = await Promise.all([getLiveMarketData(pair,twelveKey), getLiveNews(pair,finnhubKey), getEconomicCalendar(finnhubKey)]);
    const newsText = `${newsObj.text} | GESAMT-SENTIMENT: ${newsObj.sentiment} (Score: ${newsObj.score})`;
    const result = await callClaude(pair, market, newsText, calendar, session);
    res.json({ ...result, currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h, news:(newsObj&&newsObj.text?newsObj.text:"").substring(0,150) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/gemini', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, newsObj, calendar] = await Promise.all([getLiveMarketData(pair,twelveKey), getLiveNews(pair,finnhubKey), getEconomicCalendar(finnhubKey)]);
    const newsText = `${newsObj.text} | GESAMT-SENTIMENT: ${newsObj.sentiment} (Score: ${newsObj.score})`;
    const result = await callGemini(key, pair, market, newsText, calendar, session);
    res.json({ ...result, currentPrice:market.currentPrice, rsi:market.rsi, ema20:market.ema20, ema50_4h:market.ema50_4h });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/openai', async (req, res) => {
  try {
    const { key, pair, twelveKey, finnhubKey } = req.body;
    const session = getSession(new Date().getUTCHours());
    const [market, newsObj, calendar] = await Promise.all([getLiveMarketData(pair,twelveKey), getLiveNews(pair,finnhubKey), getEconomicCalendar(finnhubKey)]);
    const newsText = `${newsObj.text} | GESAMT-SENTIMENT: ${newsObj.sentiment} (Score: ${newsObj.score})`;
    const result = await callGPT(key, pair, market, newsText, calendar, session);
    res.json({ ...result, currentPrice:market.currentPrice, rsi:market.rsi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('APEX SIGNALS PROXY v5.0 — OPTIMIZED'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
