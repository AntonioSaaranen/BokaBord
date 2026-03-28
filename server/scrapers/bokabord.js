'use strict';

const { chromium } = require('playwright');

const RESTAURANTS = {
  'lilla-ego': {
    hash: 'a6ec81a26b9ea18ff9ba9852b8dcaa0b',
    name: 'Lilla Ego',
  },
  'hantverket': {
    hash: 'f7f00569986df77ef5d7b4abe98b9bed',
    name: 'Hantverket',
  },
  // Ekstedt och Oaxen Krog bokar via egna system (inte Bokabord).
  // Lämnas som stubs — fronten faller tillbaka på simulerad data.
  'ekstedt': null,
  'oaxen-krog': null,
};

/**
 * Scrape availability for a Bokabord restaurant.
 * Strategy: intercept XHR/fetch calls that Bokabord makes to its own API,
 * then walk through 3 months of calendar.
 */
async function scrapeBokabord(restaurantId) {
  const config = RESTAURANTS[restaurantId];
  if (config === undefined) throw new Error(`Unknown restaurant: ${restaurantId}`);
  // Null config = known restaurant but no Bokabord integration
  if (config === null) return { restaurantId, name: restaurantId, scraped: new Date().toISOString(), availability: {} };

  const url = `https://app.bokabord.se/reservation/?hash=${config.hash}&version=new&lang=sv`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const availability = {}; // { 'YYYY-MM-DD': 'available' | 'scarce' | 'full' | 'closed' }
  const apiResponses = [];

  // Intercept API responses that contain date/availability data
  page.on('response', async (response) => {
    const url = response.url();
    if (
      (url.includes('bokabord') || url.includes('reservation')) &&
      response.headers()['content-type']?.includes('application/json')
    ) {
      try {
        const json = await response.json();
        apiResponses.push({ url, json });
      } catch {}
    }
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Try to walk through 3 months by clicking "next month" arrows
    for (let month = 0; month < 3; month++) {
      await page.waitForTimeout(1000);

      // Extract dates from calendar — try common calendar selectors used by Bokabord
      const dates = await page.evaluate(() => {
        const results = [];

        // Bokabord typically renders days as <td> or <div> with data attributes or classes
        // Try multiple selector strategies
        const selectors = [
          '[data-date]',
          '[data-day]',
          '.calendar-day',
          '.day-cell',
          'td.available',
          'td.unavailable',
          'td.closed',
          '[class*="day"]',
        ];

        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 5) {
            els.forEach((el) => {
              const date =
                el.dataset.date ||
                el.dataset.day ||
                el.getAttribute('data-date') ||
                el.getAttribute('aria-label');
              const classes = el.className || '';
              let status = 'unknown';
              if (classes.includes('unavailable') || classes.includes('full') || classes.includes('booked')) {
                status = 'full';
              } else if (classes.includes('available') || classes.includes('open') || classes.includes('free')) {
                status = 'available';
              } else if (classes.includes('limited') || classes.includes('scarce') || classes.includes('few')) {
                status = 'scarce';
              } else if (classes.includes('closed') || classes.includes('disabled')) {
                status = 'closed';
              }
              if (date) results.push({ date, status, classes });
            });
            break;
          }
        }
        return results;
      });

      dates.forEach(({ date, status }) => {
        if (date && date.match(/\d{4}-\d{2}-\d{2}/)) {
          availability[date] = status;
        }
      });

      // Click next month if not last iteration
      if (month < 2) {
        const nextBtn = await page.$(
          'button[aria-label*="nästa"], button[aria-label*="next"], .next-month, [class*="next"], .fc-next-button, button:has-text("›"), button:has-text(">")'
        );
        if (nextBtn) {
          await nextBtn.click();
          await page.waitForTimeout(800);
        }
      }
    }

    // Also parse any intercepted API responses for date data
    for (const { json } of apiResponses) {
      parseApiResponseForDates(json, availability);
    }

  } finally {
    await browser.close();
  }

  // If we got very little DOM data, fall back to API response parsing
  if (Object.keys(availability).length < 10 && apiResponses.length > 0) {
    console.log(`[${restaurantId}] DOM parsing yielded little data, using API responses`);
    console.log(`[${restaurantId}] API endpoints hit:`, apiResponses.map((r) => r.url));
  }

  return {
    restaurantId,
    name: config.name,
    scraped: new Date().toISOString(),
    availability,
    rawApiEndpoints: apiResponses.map((r) => r.url),
  };
}

function parseApiResponseForDates(json, availability) {
  if (!json || typeof json !== 'object') return;

  // Look for arrays of date objects in any property
  const walk = (obj) => {
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (item && typeof item === 'object') {
          const dateVal =
            item.date || item.day || item.Date || item.datum;
          if (dateVal && String(dateVal).match(/\d{4}-\d{2}-\d{2}/)) {
            const available =
              item.available ??
              item.is_available ??
              item.open ??
              item.free ??
              item.slots;
            let status = 'unknown';
            if (available === true || available === 1 || (typeof available === 'number' && available > 0)) {
              status = 'available';
            } else if (available === false || available === 0) {
              status = 'full';
            }
            const match = String(dateVal).match(/\d{4}-\d{2}-\d{2}/);
            if (match) availability[match[0]] = status;
          }
          walk(item);
        }
      });
    } else if (obj && typeof obj === 'object') {
      Object.values(obj).forEach(walk);
    }
  };
  walk(json);
}

module.exports = { scrapeBokabord };
