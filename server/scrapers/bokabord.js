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
  'ag': {
    hash: '29f087bafdf8723d0918d6ed5bdf7b06',
    name: 'AG',
    domain: 'beta.waiteraid.com',
  },
  'frantzen': {
    hash: '77779be66a85c01c2efe78905bbf67e9',
    name: 'Frantzén',
  },
  // Egna bokningssystem — returnerar tom availability, fronten faller tillbaka på simulerad data
  'ekstedt': null,
  'oaxen-krog': null,
};

const MONTH_MAP = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
  Januari: 1, Februari: 2, Mars: 3, Maj: 5, Juni: 6,
  Juli: 7, Augusti: 8, Oktober: 10,
};

async function scrapeBokabord(restaurantId) {
  const config = RESTAURANTS[restaurantId];
  if (config === undefined) throw new Error(`Unknown restaurant: ${restaurantId}`);
  if (config === null) {
    return { restaurantId, name: restaurantId, scraped: new Date().toISOString(), availability: {} };
  }

  const domain = config.domain || 'app.bokabord.se';
  const url = `https://${domain}/reservation/?hash=${config.hash}&version=new&lang=sv`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const availability = {};

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 1: Click meal type — prefer "Middag", fall back to first li
    await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('li'));
      const meal = lis.find(el => el.textContent.trim().toLowerCase().includes('middag')) || lis[0];
      if (meal) meal.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(2000);

    // Step 2: Click guest count 2 — fall back to first guest li
    await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('li'));
      const guest = lis.find(el => el.textContent.trim() === '2') || lis[1];
      if (guest) guest.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    // Wait for ConsumerCalendar to render
    await page.waitForSelector('.ConsumerCalendar', { timeout: 15000 }).catch(() => {
      console.warn(`[${restaurantId}] ConsumerCalendar not found — calendar may not have loaded`);
    });
    await page.waitForTimeout(1500);

    // Scrape all visible months, navigate if we have fewer than 3
    const scrapedMonths = new Set();

    for (let pass = 0; pass < 3; pass++) {
      const months = await page.evaluate((MONTHS) => {
        const result = [];
        // Each month has its own container with heading + day grid
        const containers = document.querySelectorAll('.ConsumerCalendar-month');
        containers.forEach(container => {
          const heading = container.querySelector('.ConsumerCalendar-monthHeading');
          const headingText = heading ? heading.textContent.trim() : '';
          const match = headingText.match(/(\w+)\s+(\d{4})/);
          if (!match) return;

          const monthNum = MONTHS[match[1]];
          const year = parseInt(match[2]);
          if (!monthNum || isNaN(year)) return;

          const days = [];
          container.querySelectorAll('.ConsumerCalendar-day').forEach(el => {
            const classes = el.className;
            if (classes.includes('is-out-of-month')) return;

            const textEl = el.querySelector('.ConsumerCalendar-dayText');
            const dayNum = textEl ? parseInt(textEl.textContent.trim()) : NaN;
            if (isNaN(dayNum) || dayNum < 1) return;

            const dateStr = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;

            let status;
            if (classes.includes('is-disabled') || classes.includes('offDay')) {
              // Stängt eller fullbokat
              status = 'full';
            } else if (classes.includes('activeDay')) {
              // activeDay = dagens datum markerat i Angular — inte nödvändigtvis ledigt
              status = 'full';
            } else {
              // Ingen statusklass = ledigt att boka
              status = 'available';
            }

            days.push({ date: dateStr, status });
          });

          result.push({ headingText, monthNum, year, days });
        });
        return result;
      }, MONTH_MAP);

      let newMonthsFound = 0;
      for (const { headingText, monthNum, year, days } of months) {
        const key = `${year}-${monthNum}`;
        if (scrapedMonths.has(key)) continue;
        scrapedMonths.add(key);
        newMonthsFound++;
        console.log(`[${restaurantId}] ${headingText} — ${days.length} days`);
        days.forEach(({ date, status }) => { availability[date] = status; });
      }

      if (scrapedMonths.size >= 3) break;

      // Need more months — navigate forward
      const navigated = await page.evaluate(() => {
        const headingBtns = Array.from(document.querySelectorAll('.ConsumerCalendar-monthHeading button'));
        const ngClickEls = Array.from(document.querySelectorAll('[ng-click*="next"], [ng-click*="Next"], [ng-click*="forward"]'));
        const candidates = [...headingBtns, ...ngClickEls];

        for (const el of candidates) {
          const txt = el.textContent.trim();
          const cls = (el.className || '').toString();
          const ngClick = el.getAttribute('ng-click') || '';
          if (txt.includes('>') || txt.includes('›') || txt.includes('→') ||
              cls.includes('next') || ngClick.toLowerCase().includes('next') || ngClick.includes('forward')) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
          }
        }
        // Last resort: last button in heading area
        if (headingBtns.length > 0) {
          headingBtns[headingBtns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'fallback';
        }
        return false;
      });

      if (!navigated) {
        console.warn(`[${restaurantId}] Cannot navigate further (pass ${pass})`);
        break;
      }
      await page.waitForTimeout(1500);
    }

  } finally {
    await browser.close();
  }

  console.log(`[${restaurantId}] Scraped ${Object.keys(availability).length} dates`);
  return {
    restaurantId,
    name: config.name,
    scraped: new Date().toISOString(),
    availability,
  };
}

/**
 * Scrape lediga tidsluckor för ett specifikt datum och antal gäster.
 */
async function scrapeTimeslots(restaurantId, dateStr, guests) {
  const config = RESTAURANTS[restaurantId];
  if (!config) throw new Error(`Unknown restaurant: ${restaurantId}`);

  const [year, month, day] = dateStr.split('-').map(Number);

  const domain = config.domain || 'app.bokabord.se';
  const url = `https://${domain}/reservation/?hash=${config.hash}&version=new&lang=sv`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Steg 1: Klicka måltidstyp — föredrar "Middag", faller annars tillbaka på första li
    await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('li'));
      const meal = lis.find(el => el.textContent.trim().toLowerCase().includes('middag')) || lis[0];
      if (meal) meal.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(2000);

    // Steg 2: Antal gäster
    await page.evaluate((g) => {
      const li = Array.from(document.querySelectorAll('li')).find(el =>
        el.textContent.trim() === String(g)
      );
      if (li) li.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, guests);

    await page.waitForSelector('.ConsumerCalendar', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Steg 3: Navigera till rätt månad om den inte syns
    for (let pass = 0; pass < 6; pass++) {
      const monthVisible = await page.evaluate(({ targetYear, targetMonth, MONTHS }) => {
        const containers = document.querySelectorAll('.ConsumerCalendar-month');
        for (const container of containers) {
          const heading = container.querySelector('.ConsumerCalendar-monthHeading');
          if (!heading) continue;
          const match = heading.textContent.trim().match(/(\w+)\s+(\d{4})/);
          if (!match) continue;
          if (MONTHS[match[1]] === targetMonth && parseInt(match[2]) === targetYear) return true;
        }
        return false;
      }, { targetYear: year, targetMonth: month, MONTHS: MONTH_MAP });

      if (monthVisible) break;

      // Navigera framåt
      const navigated = await page.evaluate(() => {
        const headingBtns = Array.from(document.querySelectorAll('.ConsumerCalendar-monthHeading button'));
        const ngClickEls = Array.from(document.querySelectorAll('[ng-click*="next"], [ng-click*="Next"], [ng-click*="forward"]'));
        const candidates = [...headingBtns, ...ngClickEls];
        for (const el of candidates) {
          const txt = el.textContent.trim();
          const cls = (el.className || '').toString();
          const ngClick = el.getAttribute('ng-click') || '';
          if (txt.includes('>') || txt.includes('›') || txt.includes('→') ||
              cls.includes('next') || ngClick.toLowerCase().includes('next') || ngClick.includes('forward')) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
          }
        }
        if (headingBtns.length > 0) {
          headingBtns[headingBtns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      });

      if (!navigated) break;
      await page.waitForTimeout(1000);
    }

    // Steg 4: Klicka på rätt datum
    const clicked = await page.evaluate(({ targetYear, targetMonth, targetDay, MONTHS }) => {
      const containers = document.querySelectorAll('.ConsumerCalendar-month');
      for (const container of containers) {
        const heading = container.querySelector('.ConsumerCalendar-monthHeading');
        if (!heading) continue;
        const match = heading.textContent.trim().match(/(\w+)\s+(\d{4})/);
        if (!match) continue;
        if (MONTHS[match[1]] !== targetMonth || parseInt(match[2]) !== targetYear) continue;

        for (const dayEl of container.querySelectorAll('.ConsumerCalendar-day')) {
          if (dayEl.className.includes('is-out-of-month')) continue;
          if (dayEl.className.includes('is-disabled')) continue;
          const txt = dayEl.querySelector('.ConsumerCalendar-dayText');
          if (txt && parseInt(txt.textContent.trim()) === targetDay) {
            dayEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
          }
        }
      }
      return false;
    }, { targetYear: year, targetMonth: month, targetDay: day, MONTHS: MONTH_MAP });

    if (!clicked) {
      console.warn(`[${restaurantId}] Datum ${dateStr} ej klickbart`);
      return { restaurantId, date: dateStr, guests, slots: [] };
    }

    // Vänta på tidsluckor
    await page.waitForTimeout(3000);

    // Extrahera tidsluckor från TimesList-item li-element
    const slots = await page.evaluate(() => {
      const result = [];
      document.querySelectorAll('li.TimesList-item').forEach(el => {
        const timeEl = el.querySelector('.TimesList-itemTime');
        const time = timeEl ? timeEl.textContent.trim() : '';
        if (!time.match(/^\d{1,2}:\d{2}$/)) return;
        const isBooked = el.className.includes('not-available');
        result.push({ time, status: isBooked ? 'booked' : 'open' });
      });
      return result;
    });

    console.log(`[${restaurantId}] ${dateStr} ${guests}p — ${slots.length} tidsluckor`);
    return { restaurantId, date: dateStr, guests, slots };

  } finally {
    await browser.close();
  }
}

module.exports = { scrapeBokabord, scrapeTimeslots };
