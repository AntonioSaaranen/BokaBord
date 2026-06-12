'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeBokabord, scrapeTimeslots, closeBrowser } = require('./scrapers/bokabord');
const watchlist = require('./watchlist');

const app = express();
const PORT = process.env.PORT || 3000;

// Aktiva restauranger — övriga är pausade för att hålla nere antalet scrapes.
// Lägg tillbaka id:n här för att aktivera fler igen.
const ACTIVE_RESTAURANTS = ['lilla-ego', 'frantzen'];
const KNOWN_RESTAURANTS = ['lilla-ego', 'hantverket', 'frantzen', 'ekstedt', 'oaxen-krog', 'ag'];

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

// ── Bakgrundsverifiering av "lediga" dagar ───────────────────────────
// Månadsvyn på bokabord.se gråmarkerar bara helt stängda dagar, så en dag
// där alla tider är bortbokade ser ändå ledig ut. Efter varje kalender-
// scrape verifieras därför de gröna dagarna i lugn takt (en var 30:e
// sekund) mot tidsluckorna, och dagar utan öppna tider rättas till 'full'.

const VERIFY_DELAY_MS = 30 * 1000;
const verifying = new Set();

function scheduleVerification(restaurantId, data) {
  if (verifying.has(restaurantId)) return;
  const dates = Object.keys(data.availability)
    .filter((d) => data.availability[d] === 'available')
    .sort();
  if (dates.length === 0) return;
  verifying.add(restaurantId);

  (async () => {
    try {
      for (const date of dates) {
        await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
        const entry = cache.get(restaurantId);
        if (!entry || entry.data !== data) return; // en nyare scrape har tagit över
        try {
          const key = `timeslots:${restaurantId}:${date}:2`;
          const result = await singleFlight(key, () => scrapeTimeslots(restaurantId, date, 2), TIMESLOT_TTL_MS);
          if (!result.slots.some((s) => s.status === 'open')) {
            data.availability[date] = 'full';
            console.log(`[verify] ${restaurantId} ${date} → full (inga öppna tider)`);
          }
        } catch (err) {
          console.warn(`[verify] ${restaurantId} ${date}:`, err.message);
        }
      }
      console.log(`[verify] ${restaurantId} klar — ${dates.length} dagar kontrollerade`);
    } finally {
      verifying.delete(restaurantId);
    }
  })();
}

async function scrapeAndVerify(restaurantId) {
  const data = await scrapeBokabord(restaurantId);
  scheduleVerification(restaurantId, data);
  return data;
}

// GET /api/availability/:restaurant
app.get('/api/availability/:restaurant', async (req, res) => {
  const { restaurant } = req.params;

  if (!KNOWN_RESTAURANTS.includes(restaurant)) {
    return res.status(404).json({ error: 'Unknown restaurant' });
  }

  if (!ACTIVE_RESTAURANTS.includes(restaurant)) {
    return res.json({ restaurantId: restaurant, paused: true, availability: {} });
  }

  try {
    const data = await singleFlight(restaurant, () => scrapeAndVerify(restaurant));
    res.json(data);
  } catch (err) {
    console.error(`[error] ${restaurant}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/availability — alla aktiva restauranger i parallell
app.get('/api/availability', async (req, res) => {
  try {
    const results = await Promise.allSettled(
      ACTIVE_RESTAURANTS.map((id) => singleFlight(id, () => scrapeAndVerify(id)))
    );

    const payload = {};
    ACTIVE_RESTAURANTS.forEach((id, i) => {
      const r = results[i];
      payload[id] = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
    });
    res.json(payload);
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

  if (!ACTIVE_RESTAURANTS.includes(restaurant)) {
    return res.status(404).json({ error: 'Tidsluckor ej tillgängliga för denna restaurang' });
  }

  const key = `timeslots:${restaurant}:${date}:${guestsNum}`;
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('scrape timeout')), 25000)
    );
    const data = await Promise.race([
      singleFlight(key, () => scrapeTimeslots(restaurant, date, guestsNum), TIMESLOT_TTL_MS),
      timeout,
    ]);

    // Self-correct: if no open slots came back, fix the availability cache so the
    // calendar updates on next load instead of staying misleadingly green.
    if (!data.slots.some((s) => s.status === 'open')) {
      const availKey = restaurant;
      const entry = cache.get(availKey);
      if (entry && entry.data && entry.data.availability && entry.data.availability[date] === 'available') {
        entry.data.availability[date] = 'full';
        console.log(`[timeslots] self-correct: ${restaurant} ${date} → full (0 slots)`);
      }
    }

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
  const { restaurantId, restaurantName, date, guests, preferredTimes, firstName, lastName, email, phone, autoBook } = req.body;
  if (!restaurantId || !date || !guests || !firstName || !lastName || !email) {
    return res.status(400).json({ error: 'restaurantId, date, guests, firstName, lastName och email krävs' });
  }
  if (!ACTIVE_RESTAURANTS.includes(restaurantId)) {
    return res.status(400).json({ error: 'Restaurangen är pausad — bevakning ej möjlig just nu' });
  }
  const id = watchlist.add({ restaurantId, restaurantName, date, guests, preferredTimes, firstName, lastName, email, phone, autoBook: !!autoBook });
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closeBrowser().finally(() => process.exit(0));
  });
}
