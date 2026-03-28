'use strict';

const { chromium } = require('playwright');

const FRANTZEN_URL = 'https://www.restaurantfrantzen.com/';
const SEVENROOMS_VENUE = 'frantzen';

/**
 * Scrape Frantzén availability via SevenRooms widget.
 * Strategy 1: Intercept SevenRooms API calls made by the widget.
 * Strategy 2: Interact with the embedded widget directly.
 */
async function scrapeFrantzen() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const availability = {};
  const interceptedData = [];

  // Intercept SevenRooms API calls — they typically hit api.sevenrooms.com
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('sevenrooms.com') && response.headers()['content-type']?.includes('application/json')) {
      try {
        const json = await response.json();
        interceptedData.push({ url, json });
      } catch {}
    }
  });

  try {
    await page.goto(FRANTZEN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Try to trigger the booking widget by clicking a reservation button
    const reserveBtn = await page.$(
      'a[href*="reserv"], button:has-text("Reserv"), a:has-text("Reserv"), a:has-text("Book"), button:has-text("Book"), [class*="reserv"], [class*="book"]'
    );
    if (reserveBtn) {
      await reserveBtn.click();
      await page.waitForTimeout(3000);
    }

    // Also try direct SevenRooms widget URL for the venue
    // SevenRooms exposes availability via a widget that can be loaded directly
    const srPage = await context.newPage();
    srPage.on('response', async (response) => {
      const url = response.url();
      if (url.includes('sevenrooms.com') && response.headers()['content-type']?.includes('application/json')) {
        try {
          const json = await response.json();
          interceptedData.push({ url, json });
        } catch {}
      }
    });

    // Load SevenRooms widget page for the venue
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    await srPage.goto(
      `https://www.sevenrooms.com/reservations/${SEVENROOMS_VENUE}`,
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await srPage.waitForTimeout(2000);

    // Walk 3 months of the SevenRooms calendar
    for (let month = 0; month < 3; month++) {
      await srPage.waitForTimeout(1000);

      // Extract day availability from SevenRooms calendar
      const dates = await srPage.evaluate(() => {
        const results = [];
        const dayEls = document.querySelectorAll(
          '[data-test*="day"], [class*="day-cell"], [class*="calendar-day"], td[data-date], [aria-label*="2025"], [aria-label*="2026"]'
        );
        dayEls.forEach((el) => {
          const dateAttr =
            el.getAttribute('data-date') ||
            el.getAttribute('data-day') ||
            el.getAttribute('aria-label');
          const classes = el.className || '';
          let status = 'unknown';
          if (
            classes.includes('unavailable') ||
            classes.includes('disabled') ||
            el.hasAttribute('disabled') ||
            classes.includes('fully-booked')
          ) {
            status = 'full';
          } else if (classes.includes('available') || classes.includes('selectable')) {
            status = 'available';
          }
          if (dateAttr) results.push({ date: dateAttr, status, classes });
        });
        return results;
      });

      dates.forEach(({ date, status }) => {
        const match = String(date).match(/\d{4}-\d{2}-\d{2}/);
        if (match) availability[match[0]] = status;
      });

      // Navigate to next month
      if (month < 2) {
        const nextBtn = await srPage.$(
          'button[aria-label*="next"], button[aria-label*="Next"], [class*="next-month"], [data-test*="next"]'
        );
        if (nextBtn) {
          await nextBtn.click();
          await srPage.waitForTimeout(800);
        }
      }
    }

    await srPage.close();

  } finally {
    await browser.close();
  }

  // Parse intercepted API responses for availability data
  for (const { url, json } of interceptedData) {
    parseSevenRoomsResponse(url, json, availability);
  }

  return {
    restaurantId: 'frantzen',
    name: 'Frantzén',
    scraped: new Date().toISOString(),
    availability,
    rawApiEndpoints: interceptedData.map((d) => d.url),
  };
}

function parseSevenRoomsResponse(url, json, availability) {
  if (!json || typeof json !== 'object') return;

  // SevenRooms typically returns availability in `data.availability` or similar
  const walk = (obj) => {
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (item && typeof item === 'object') {
          // Look for date strings and availability flags
          const dateVal = item.date || item.Date || item.day || item.availability_date;
          if (dateVal) {
            const match = String(dateVal).match(/\d{4}-\d{2}-\d{2}/);
            if (match) {
              const avail =
                item.is_available ??
                item.available ??
                item.has_availability ??
                (item.slots != null ? item.slots > 0 : undefined);
              if (avail === true || avail === 1) availability[match[0]] = 'available';
              else if (avail === false || avail === 0) availability[match[0]] = 'full';
            }
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

module.exports = { scrapeFrantzen };
