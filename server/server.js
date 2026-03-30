'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeBokabord, scrapeTimeslots } = require('./scrapers/bokabord');
const watchlist = require('./watchlist');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..')));
app.use(cors());
app.use(express.json());

// In-memory cache: { key: { data, expiresAt } }
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;        // 30 min för tillgänglighet
const TIMESLOT_TTL_MS = 5 * 60 * 1000;      // 5 min för tidsluckor

function cached(key, fetchFn, ttl = CACHE_TTL_MS) {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    console.log(`[cache] hit: ${key}`);
    return Promise.resolve(entry.data);
  }
  console.log(`[cache] miss: ${key} — scraping...`);
  return fetchFn().then((data) => {
    cache.set(key, { data, expiresAt: Date.now() + ttl });
    return data;
  });
}

// Scrape status tracker to prevent parallel scrapes of same restaurant
const inFlight = new Map();

function singleFlight(key, fetchFn, ttl = CACHE_TTL_MS) {
  if (inFlight.has(key)) {
    console.log(`[inflight] waiting for existing scrape: ${key}`);
    return inFlight.get(key);
  }
  const promise = cached(key, fetchFn, ttl).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// GET /api/availability/:restaurant
app.get('/api/availability/:restaurant', async (req, res) => {
  const { restaurant } = req.params;

  const scrapers = {
    'lilla-ego': () => scrapeBokabord('lilla-ego'),
    'hantverket': () => scrapeBokabord('hantverket'),
    'frantzen': () => scrapeBokabord('frantzen'),
    'ekstedt': () => scrapeBokabord('ekstedt'),
    'oaxen-krog': () => scrapeBokabord('oaxen-krog'),
    'ag': () => scrapeBokabord('ag'),
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
    const [lillaEgo, hantverket, frantzen, ekstedt, oaxenKrog, ag] = await Promise.allSettled([
      singleFlight('lilla-ego', () => scrapeBokabord('lilla-ego')),
      singleFlight('hantverket', () => scrapeBokabord('hantverket')),
      singleFlight('frantzen', () => scrapeBokabord('frantzen')),
      singleFlight('ekstedt', () => scrapeBokabord('ekstedt')),
      singleFlight('oaxen-krog', () => scrapeBokabord('oaxen-krog')),
      singleFlight('ag', () => scrapeBokabord('ag')),
    ]);

    res.json({
      'lilla-ego': lillaEgo.status === 'fulfilled' ? lillaEgo.value : { error: lillaEgo.reason?.message },
      'hantverket': hantverket.status === 'fulfilled' ? hantverket.value : { error: hantverket.reason?.message },
      'frantzen': frantzen.status === 'fulfilled' ? frantzen.value : { error: frantzen.reason?.message },
      'ekstedt': ekstedt.status === 'fulfilled' ? ekstedt.value : { error: ekstedt.reason?.message },
      'oaxen-krog': oaxenKrog.status === 'fulfilled' ? oaxenKrog.value : { error: oaxenKrog.reason?.message },
      'ag': ag.status === 'fulfilled' ? ag.value : { error: ag.reason?.message },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timeslots/:restaurant?date=YYYY-MM-DD&guests=2
app.get('/api/timeslots/:restaurant', async (req, res) => {
  const { restaurant } = req.params;
  const { date, guests = '2' } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date krävs i formatet YYYY-MM-DD' });
  }

  const guestsNum = Math.max(1, Math.min(10, parseInt(guests) || 2));
  const supported = ['lilla-ego', 'hantverket', 'ag', 'frantzen'];

  if (!supported.includes(restaurant)) {
    return res.status(404).json({ error: 'Tidsluckor ej tillgängliga för denna restaurang' });
  }

  const key = `timeslots:${restaurant}:${date}:${guestsNum}`;
  try {
    const data = await singleFlight(key, () => scrapeTimeslots(restaurant, date, guestsNum), TIMESLOT_TTL_MS);
    res.json(data);
  } catch (err) {
    console.error(`[timeslots] ${restaurant} ${date}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cache/clear — manual cache invalidation
app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ ok: true, message: 'Cache cleared' });
});

// ── Watchlist API ─────────────────────────────────────────────────────

// POST /api/watchlist — add entry
app.post('/api/watchlist', (req, res) => {
  const { restaurantId, restaurantName, date, guests, timePreference, name, email, phone } = req.body;
  if (!restaurantId || !date || !guests || !name || !email) {
    return res.status(400).json({ error: 'restaurantId, date, guests, name och email krävs' });
  }
  const id = watchlist.add({ restaurantId, restaurantName, date, guests, timePreference, name, email, phone });
  res.json({ ok: true, id });
});

// DELETE /api/watchlist/:id — remove entry
app.delete('/api/watchlist/:id', (req, res) => {
  watchlist.remove(req.params.id);
  res.json({ ok: true });
});

// GET /api/watchlist/alerts — pop pending alerts
app.get('/api/watchlist/alerts', (req, res) => {
  res.json({ alerts: watchlist.popAlerts() });
});

app.listen(PORT, () => {
  console.log(`\nBoka Bord server running at http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/availability\n`);
  watchlist.start();
});
