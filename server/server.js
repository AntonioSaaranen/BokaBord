'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeBokabord } = require('./scrapers/bokabord');
const { scrapeFrantzen } = require('./scrapers/frantzen');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..')));
app.use(cors());

// In-memory cache: { key: { data, expiresAt } }
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cached(key, fetchFn) {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    console.log(`[cache] hit: ${key}`);
    return Promise.resolve(entry.data);
  }
  console.log(`[cache] miss: ${key} — scraping...`);
  return fetchFn().then((data) => {
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  });
}

// Scrape status tracker to prevent parallel scrapes of same restaurant
const inFlight = new Map();

function singleFlight(key, fetchFn) {
  if (inFlight.has(key)) {
    console.log(`[inflight] waiting for existing scrape: ${key}`);
    return inFlight.get(key);
  }
  const promise = cached(key, fetchFn).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// GET /api/availability/:restaurant
app.get('/api/availability/:restaurant', async (req, res) => {
  const { restaurant } = req.params;

  const scrapers = {
    'lilla-ego': () => scrapeBokabord('lilla-ego'),
    'hantverket': () => scrapeBokabord('hantverket'),
    'frantzen': () => scrapeFrantzen(),
    'ekstedt': () => scrapeBokabord('ekstedt'),
    'oaxen-krog': () => scrapeBokabord('oaxen-krog'),
  };

  if (!scrapers[restaurant]) {
    return res.status(404).json({ error: 'Unknown restaurant' });
  }

  try {
    const data = await singleFlight(restaurant, scrapers[restaurant]);
    res.json(data);
  } catch (err) {
    console.error(`[error] ${restaurant}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/availability — all restaurants in parallel
app.get('/api/availability', async (req, res) => {
  try {
    const [lillaEgo, hantverket, frantzen, ekstedt, oaxenKrog] = await Promise.allSettled([
      singleFlight('lilla-ego', () => scrapeBokabord('lilla-ego')),
      singleFlight('hantverket', () => scrapeBokabord('hantverket')),
      singleFlight('frantzen', () => scrapeFrantzen()),
      singleFlight('ekstedt', () => scrapeBokabord('ekstedt')),
      singleFlight('oaxen-krog', () => scrapeBokabord('oaxen-krog')),
    ]);

    res.json({
      'lilla-ego': lillaEgo.status === 'fulfilled' ? lillaEgo.value : { error: lillaEgo.reason?.message },
      'hantverket': hantverket.status === 'fulfilled' ? hantverket.value : { error: hantverket.reason?.message },
      'frantzen': frantzen.status === 'fulfilled' ? frantzen.value : { error: frantzen.reason?.message },
      'ekstedt': ekstedt.status === 'fulfilled' ? ekstedt.value : { error: ekstedt.reason?.message },
      'oaxen-krog': oaxenKrog.status === 'fulfilled' ? oaxenKrog.value : { error: oaxenKrog.reason?.message },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cache/clear — manual cache invalidation
app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ ok: true, message: 'Cache cleared' });
});

app.listen(PORT, () => {
  console.log(`\nBoka Bord server running at http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/availability\n`);
});
