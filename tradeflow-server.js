require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY missing. Add it in Railway Variables.');
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// Simple fetch using built-in https (no external fetch library needed)
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Cache (2 hours)
const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;
function getCached(key) {
  const e = cache.get(key);
  if (!e || Date.now() - e.time > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) { cache.set(key, { data, time: Date.now() }); }

// Rate limit (10 per IP per hour)
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now = Date.now(), window = 3600000, max = 10;
  const times = (rateLimits.get(ip) || []).filter(t => now - t < window);
  rateLimits.set(ip, times);
  if (times.length >= max) return false;
  times.push(now);
  return true;
}

// GET /leads?area=Manchester&radius=10&trade=Plumber
app.get('/leads', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { area, radius = '10', trade = 'General contractor', keywords = '' } = req.query;

  if (!area) return res.status(400).json({ error: 'area is required' });
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many searches. Try again in an hour.' });

  const cacheKey = `${area}|${radius}|${trade}|${keywords}`.toLowerCase();
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // Step 1 — resolve area to lat/lng
    let lat, lng, district = area;

    const isPostcode = /^[A-Z]{1,2}\d/i.test(area);
    if (isPostcode) {
      const r = await fetchJSON(`https://api.postcodes.io/postcodes/${encodeURIComponent(area)}`);
      const d = r.json();
      if (d.status === 200) { lat = d.result.latitude; lng = d.result.longitude; district = d.result.admin_district; }
    }
    if (!lat) {
      const r = await fetchJSON(`https://api.postcodes.io/places?q=${encodeURIComponent(area)}&limit=1`);
      const d = r.json();
      if (d.status === 200 && d.result?.[0]) { lat = d.result[0].latitude; lng = d.result[0].longitude; district = d.result[0].name_1 || area; }
    }
    if (!lat) return res.status(400).json({ error: `Location not found: "${area}". Try a UK postcode like M1 1AE or a city name like Manchester.` });

    // Step 2 — fetch real planning applications
    const deg = parseFloat(radius) / 69.0;
    const planningUrl = `https://www.planning.data.gov.uk/entity.json?dataset=planning-application&entries=current&limit=50&field=reference&field=name&field=address&field=description&field=start-date&field=entry-date&longitude__gte=${(lng-deg).toFixed(6)}&longitude__lte=${(lng+deg).toFixed(6)}&latitude__gte=${(lat-deg).toFixed(6)}&latitude__lte=${(lat+deg).toFixed(6)}`;

    let apps = [], realData = false;
    try {
      const r = await fetchJSON(planningUrl);
      const d = r.json();
      apps = d.entities || [];
      realData = apps.length > 0;
      console.log(`Planning API: ${apps.length} results near ${area}`);
    } catch(e) { console.log('Planning API unavailable, using AI fallback'); }

    // Step 3 — score with Claude
    const prompt = realData
      ? `You are a lead scoring AI for TradeFlow UK.\nTrade: ${trade}\nArea: ${district}\n${keywords?'Keywords: '+keywords+'\n':''}\nReal UK government planning applications:\n${apps.slice(0,25).map((a,i)=>`${i+1}. Ref:${a.reference||'N/A'} | ${a.address||a.name||'?'} | ${a.description||a.name||'Application'}`).join('\n')}\n\nScore relevant ones for a ${trade}. Skip commercial/irrelevant.\nReturn ONLY JSON array, no markdown:\n[{"ref":"...","address":"...","summary":"2 sentences why a ${trade} should contact","score":50-97,"type":"Rear extension|Loft conversion|New build|Renovation|Bathroom|Kitchen|Roof","timeframe":"Recently approved|Under consideration|ASAP","budget":"£2k-5k|£5k-15k|£15k-40k|£40k+|Not stated"}]`
      : `You are a lead generation AI for TradeFlow UK.\nTrade: ${trade}\nArea: ${district} (${area})\n${keywords?'Keywords: '+keywords+'\n':''}\nGenerate 8 realistic residential construction leads for a ${trade} in ${district}. Use realistic UK street names for ${area}. Vary project types and budgets.\nReturn ONLY JSON array, no markdown:\n[{"ref":"N/A","address":"realistic UK address in ${area}","summary":"what work needed and why contact urgently","score":55-92,"type":"Rear extension|Loft conversion|New build|Renovation|Bathroom|Kitchen|Roof","timeframe":"ASAP|Recently approved|Under consideration|Within 3 months","budget":"£2k-5k|£5k-15k|£15k-40k|£40k+|Not stated"}]`;

    const aiRes = await fetchJSON('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });

    if (!aiRes.ok) throw new Error('AI error ' + aiRes.status);

    const aiData = aiRes.json();
    const raw = (aiData.content||[]).map(b=>b.text||'').join('');
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI returned no results');

    const leads = JSON.parse(match[0]);
    const result = { area, district, source: realData ? 'UK Planning Portal (gov.uk)' : 'AI generated', real_data: realData, total: leads.length, leads, cached: false, timestamp: new Date().toISOString() };

    setCache(cacheKey, result);
    console.log(`Done: ${leads.length} leads for ${trade} near ${area}`);
    res.json(result);

  } catch(err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'TradeFlow API running ✅', test: '/leads?area=Manchester&trade=Plumber&radius=10' }));

app.listen(PORT, () => console.log(`\n✅ TradeFlow server running on port ${PORT}\n`));
