require('dotenv').config();
 
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
 
const app  = express();
const PORT = process.env.PORT || 8080;
const GROQ_KEY      = process.env.GROQ_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
 
app.use(cors());
app.use(express.json());
 
function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timed out')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}
 
const cache = new Map();
function getCached(key) {
  const e = cache.get(key);
  if (!e || Date.now() - e.time > 7200000) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) { cache.set(key, { data, time: Date.now() }); }
 
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now   = Date.now();
  const times = (rateLimits.get(ip) || []).filter(t => now - t < 3600000);
  rateLimits.set(ip, times);
  if (times.length >= 20) return false;
  times.push(now);
  return true;
}
 
async function callAI(prompt) {
  // Try Anthropic first
  if (ANTHROPIC_KEY) {
    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }]
      });
      const r = await fetchURL('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length':    Buffer.byteLength(body)
        },
        body
      });
      console.log('[ANTHROPIC] status:', r.status);
      if (r.status === 200) {
        const d = JSON.parse(r.body);
        return (d.content || []).map(b => b.text || '').join('');
      }
      console.log('[ANTHROPIC] error body:', r.body.substring(0, 300));
    } catch(e) {
      console.log('[ANTHROPIC] failed:', e.message);
    }
  }
 
  // Try Groq as fallback
  if (GROQ_KEY) {
    const models = ['llama-3.1-8b-instant', 'llama3-8b-8192', 'mixtral-8x7b-32768'];
    for (const model of models) {
      try {
        const body = JSON.stringify({
          model,
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        });
        const r = await fetchURL('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type':   'application/json',
            'Authorization':  'Bearer ' + GROQ_KEY,
            'Content-Length': Buffer.byteLength(body)
          },
          body
        });
        console.log('[GROQ] model:', model, 'status:', r.status);
        if (r.status === 200) {
          const d = JSON.parse(r.body);
          return d.choices[0].message.content;
        }
        console.log('[GROQ] error:', r.body.substring(0, 300));
      } catch(e) {
        console.log('[GROQ] model', model, 'failed:', e.message);
      }
    }
  }
 
  throw new Error('All AI providers failed');
}
 
app.get('/leads', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { area, radius = '10', trade = 'General contractor', keywords = '' } = req.query;
 
  if (!area) return res.status(400).json({ error: 'area is required' });
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many searches. Try again later.' });
 
  const cacheKey = `${area}|${radius}|${trade}|${keywords}`.toLowerCase();
  const cached   = getCached(cacheKey);
  if (cached) { console.log('[CACHE]', area); return res.json({ ...cached, cached: true }); }
 
  try {
    let lat, lng, district = area;
 
    const isPostcode = /^[A-Z]{1,2}\d/i.test(area.trim());
    if (isPostcode) {
      const r = await fetchURL('https://api.postcodes.io/postcodes/' + encodeURIComponent(area.trim()));
      const d = JSON.parse(r.body);
      if (d.status === 200) { lat = d.result.latitude; lng = d.result.longitude; district = d.result.admin_district || area; }
    }
    if (!lat) {
      const r = await fetchURL('https://api.postcodes.io/places?q=' + encodeURIComponent(area) + '&limit=1');
      const d = JSON.parse(r.body);
      if (d.status === 200 && d.result && d.result.length > 0) { lat = d.result[0].latitude; lng = d.result[0].longitude; district = d.result[0].name_1 || area; }
    }
    if (!lat) return res.status(400).json({ error: 'Location not found: ' + area });
 
    console.log('[SEARCH]', area, '->', district, lat, lng, '| trade:', trade);
 
    const deg = parseFloat(radius) / 69.0;
    const planningUrl = 'https://www.planning.data.gov.uk/entity.json?dataset=planning-application&entries=current&limit=50&field=reference&field=name&field=address&field=site-address&field=street-address&field=description&field=start-date&longitude__gte=' + (lng-deg).toFixed(6) + '&longitude__lte=' + (lng+deg).toFixed(6) + '&latitude__gte=' + (lat-deg).toFixed(6) + '&latitude__lte=' + (lat+deg).toFixed(6);
 
    let apps = [], realData = false;
    try {
      const r = await fetchURL(planningUrl);
      const d = JSON.parse(r.body);
      apps     = d.entities || [];
      realData = apps.length > 0;
      console.log('[PLANNING]', apps.length, 'apps near', area);
    } catch(e) { console.log('[PLANNING] failed:', e.message); }
 
    const prompt = realData
      ? 'You are a lead scoring AI for TradeFlow UK.\nTrade: ' + trade + '\nArea: ' + district + '\n' + (keywords?'Keywords: '+keywords+'\n':'') + '\nReal UK planning applications:\n' + apps.slice(0,10).map((a,i) => {
          const addr = a['site-address'] || a.address || a['street-address'] || a.name || 'Address not available';
          const ref  = a.reference || 'N/A';
          const desc = a.description || a.name || 'Planning application';
          return (i+1)+'. Ref:'+ref+' | Address:'+addr+' | '+desc;
        }).join('\n') + '\n\nPick the 5 most relevant for a ' + trade + '. IMPORTANT: Copy the EXACT address from above into the address field. Do not replace it with just the city name.\nReturn ONLY a valid complete JSON array, no markdown:\n[{"ref":"...","address":"EXACT address from data above","summary":"why contact","score":55-97,"type":"Extension|Conversion|New build|Renovation","timeframe":"Approved|Pending|ASAP","budget":"2k-5k|5k-15k|15k-40k|40k+|Unknown"}]'
      : 'You are a lead generation AI for TradeFlow UK.\nGenerate 5 residential construction leads for a ' + trade + ' in ' + district + ' (' + area + '). Use realistic full UK street addresses with house number, street name and postcode.\nReturn ONLY a valid complete JSON array, no markdown:\n[{"ref":"N/A","address":"e.g. 42 Oak Street, Manchester, M14 5AB","summary":"work needed","score":60-90,"type":"Extension|Conversion|Renovation","timeframe":"ASAP|Soon|3 months","budget":"2k-5k|5k-15k|15k-40k|40k+|Unknown"}]';
 
    const raw   = await callAI(prompt);
    console.log('[AI RAW]', raw.substring(0, 200));
    const cleaned = raw.replace(/```json/g,'').replace(/```/g,'').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI returned no JSON. Raw: ' + cleaned.substring(0, 200));
 
    const leads = JSON.parse(match[0]);
    console.log('[DONE]', leads.length, 'leads for', trade, 'near', area);
 
    const result = { area, district, source: realData ? 'UK Planning Portal' : 'AI generated', real_data: realData, total: leads.length, leads, cached: false, timestamp: new Date().toISOString() };
    setCache(cacheKey, result);
    res.json(result);
 
  } catch(err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/test', async (req, res) => {
  const results = { groq_key: !!GROQ_KEY, anthropic_key: !!ANTHROPIC_KEY };
  try {
    const r = await callAI('Reply with just the word WORKS');
    results.ai_test = 'SUCCESS: ' + r.substring(0, 50);
  } catch(e) {
    results.ai_test = 'FAILED: ' + e.message;
  }
  res.json(results);
});
 
app.get('/', (req, res) => res.json({ status: 'TradeFlow API running', test: '/leads?area=Manchester&trade=Plumber&radius=10' }));
 
app.listen(PORT, () => console.log('TradeFlow server on port ' + PORT));
 
