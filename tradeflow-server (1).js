require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const https    = require('https');
const http     = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY missing. Add it in Railway Variables.');
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// ── HTTP fetch helper ──
function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const lib      = parsed.protocol === 'https:' ? https : http;
    const opts     = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {}
    };

    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Cache (2 hours) ──
const cache = new Map();
function getCached(key) {
  const e = cache.get(key);
  if (!e || Date.now() - e.time > 7200000) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) { cache.set(key, { data, time: Date.now() }); }

// ── Rate limit (10/hr per IP) ──
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now   = Date.now();
  const times = (rateLimits.get(ip) || []).filter(t => now - t < 3600000);
  rateLimits.set(ip, times);
  if (times.length >= 10) return false;
  times.push(now);
  return true;
}

// ════════════════════════════════
//  GET /leads
// ════════════════════════════════
app.get('/leads', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { area, radius = '10', trade = 'General contractor', keywords = '' } = req.query;

  if (!area) return res.status(400).json({ error: 'area is required' });
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many searches. Try again in an hour.' });

  const cacheKey = `${area}|${radius}|${trade}|${keywords}`.toLowerCase();
  const cached   = getCached(cacheKey);
  if (cached) { console.log('[CACHE]', area); return res.json({ ...cached, cached: true }); }

  try {
    // ── Step 1: area → lat/lng ──
    let lat, lng, district = area;

    const isPostcode = /^[A-Z]{1,2}\d/i.test(area.trim());
    if (isPostcode) {
      const r = await fetchURL(`https://api.postcodes.io/postcodes/${encodeURIComponent(area.trim())}`);
      const d = JSON.parse(r.body);
      if (d.status === 200) {
        lat      = d.result.latitude;
        lng      = d.result.longitude;
        district = d.result.admin_district || area;
      }
    }

    if (!lat) {
      const r = await fetchURL(`https://api.postcodes.io/places?q=${encodeURIComponent(area)}&limit=1`);
      const d = JSON.parse(r.body);
      if (d.status === 200 && d.result && d.result.length > 0) {
        lat      = d.result[0].latitude;
        lng      = d.result[0].longitude;
        district = d.result[0].name_1 || area;
      }
    }

    if (!lat) {
      return res.status(400).json({ error: `Location not found: "${area}". Try a UK postcode like M1 1AE or a city like Manchester.` });
    }

    console.log(`[SEARCH] ${area} → ${district} (${lat}, ${lng})`);

    // ── Step 2: real planning applications ──
    const deg = parseFloat(radius) / 69.0;
    const planningUrl =
      `https://www.planning.data.gov.uk/entity.json` +
      `?dataset=planning-application&entries=current&limit=50` +
      `&field=reference&field=name&field=address&field=description&field=start-date` +
      `&longitude__gte=${(lng - deg).toFixed(6)}&longitude__lte=${(lng + deg).toFixed(6)}` +
      `&latitude__gte=${(lat - deg).toFixed(6)}&latitude__lte=${(lat + deg).toFixed(6)}`;

    let apps = [], realData = false;
    try {
      const r = await fetchURL(planningUrl);
      const d = JSON.parse(r.body);
      apps     = d.entities || [];
      realData = apps.length > 0;
      console.log(`[PLANNING] ${apps.length} apps found`);
    } catch(e) {
      console.log('[PLANNING] unavailable:', e.message);
    }

    // ── Step 3: Claude AI scoring ──
    const prompt = realData
      ? `You are a lead scoring AI for TradeFlow UK.\nTrade: ${trade}\nArea: ${district}\n${keywords ? 'Keywords: ' + keywords + '\n' : ''}\nReal UK government planning applications:\n${apps.slice(0, 25).map((a, i) => `${i+1}. Ref:${a.reference||'N/A'} | ${a.address||a.name||'?'} | ${a.description||a.name||'Application'}`).join('\n')}\n\nScore the relevant ones for a ${trade}. Skip commercial or irrelevant ones.\nReturn ONLY a raw JSON array, no markdown:\n[{"ref":"...","address":"...","summary":"2 sentences why a ${trade} should contact this homeowner","score":55-97,"type":"Rear extension|Loft conversion|New build|Renovation|Bathroom|Kitchen|Roof","timeframe":"Recently approved|Under consideration|ASAP|Within 3 months","budget":"£2k-5k|£5k-15k|£15k-40k|£40k+|Not stated"}]`
      : `You are a lead generation AI for TradeFlow UK.\nTrade: ${trade}\nArea: ${district} (${area})\n${keywords ? 'Keywords: ' + keywords + '\n' : ''}\nThe UK planning database returned no results for this area. Generate 8 realistic residential construction leads for a ${trade} in ${district}. Use realistic UK street names and addresses typical for the ${area} postcode area. Vary project types and budgets.\nReturn ONLY a raw JSON array, no markdown:\n[{"ref":"N/A","address":"realistic full UK address in ${area}","summary":"what work is needed and why a ${trade} should contact urgently","score":55-92,"type":"Rear extension|Loft conversion|New build|Renovation|Bathroom|Kitchen|Roof","timeframe":"ASAP|Recently approved|Under consideration|Within 3 months","budget":"£2k-5k|£5k-15k|£15k-40k|£40k+|Not stated"}]`;

    const aiBody = JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }]
    });

    const aiRes = await fetchURL('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(aiBody)
      },
      body: aiBody
    });

    if (aiRes.status !== 200) {
      console.error('[AI ERROR]', aiRes.body);
      throw new Error('AI returned status ' + aiRes.status + ': ' + aiRes.body.substring(0, 200));
    }

    const aiData = JSON.parse(aiRes.body);
    const raw    = (aiData.content || []).map(b => b.text || '').join('');
    const match  = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI returned no structured results. Raw: ' + raw.substring(0, 200));

    const leads = JSON.parse(match[0]);
    console.log(`[DONE] ${leads.length} leads for ${trade} near ${area} | real_data: ${realData}`);

    const result = {
      area, district,
      source:    realData ? 'UK Planning Portal (gov.uk)' : 'AI generated',
      real_data: realData,
      total:     leads.length,
      leads,
      cached:    false,
      timestamp: new Date().toISOString()
    };

    setCache(cacheKey, result);
    res.json(result);

  } catch(err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'TradeFlow API running ✅', test: '/leads?area=Manchester&trade=Plumber&radius=10' });
});

app.listen(PORT, () => {
  console.log(`\n✅ TradeFlow server running on port ${PORT}`);
  console.log(`   Test: http://localhost:${PORT}/leads?area=Manchester&trade=Plumber\n`);
});
