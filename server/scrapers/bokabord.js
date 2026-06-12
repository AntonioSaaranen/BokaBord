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
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const availability = {};

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Step 1: Click meal type — prefer "Middag", fall back to first li
    await page.waitForSelector('li', { timeout: 10000 });
    await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('li'));
      const meal = lis.find(el => el.textContent.trim().toLowerCase().includes('middag')) || lis[0];
      if (meal) meal.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // Step 2: Click guest count 2 — wait for SizesList to appear
    await page.waitForSelector('li', { timeout: 10000 });
    await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('li'));
      const guest = lis.find(el => el.textContent.trim() === '2') || lis[1];
      if (guest) guest.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    // Wait for ConsumerCalendar to render AND for availability API calls to complete
    await page.waitForSelector('.ConsumerCalendar', { timeout: 15000 }).catch(() => {
      console.warn(`[${restaurantId}] ConsumerCalendar not found — calendar may not have loaded`);
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Scrape all visible months, navigate if we have fewer than 3
    const scrapedMonths = new Set();

    for (let pass = 0; pass < 3; pass++) {
      const months = await page.evaluate((MONTHS) => {
        const result = [];
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
            const status = classes.includes('is-disabled') ? 'full' : 'available';
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
        const availCount = days.filter(d => d.status === 'available').length;
        console.log(`[${restaurantId}] ${headingText} — ${days.length} days, ${availCount} possibly available`);
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
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);
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
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Steg 1: Klicka måltidstyp — föredrar "Middag", faller annars tillbaka på första li
    await page.waitForSelector('li', { timeout: 10000 });
    await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('li'));
      const meal = lis.find(el => el.textContent.trim().toLowerCase().includes('middag')) || lis[0];
      if (meal) meal.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // Steg 2: Antal gäster
    await page.waitForSelector('li', { timeout: 10000 });
    await page.evaluate((g) => {
      const li = Array.from(document.querySelectorAll('li')).find(el =>
        el.textContent.trim() === String(g)
      );
      if (li) li.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, guests);

    await page.waitForSelector('.ConsumerCalendar', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

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
      await page.waitForTimeout(500);
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
    await page.waitForSelector('li.TimesList-item', { timeout: 8000 }).catch(() => {});

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

/**
 * Navigerar till restaurangens bokningssida, väljer datum/tid och fyller i
 * bokningsformuläret med användarens uppgifter. Returnerar { success, reason }.
 * user: { firstName, lastName, email, phone }
 *
 * Flödet är härlett från ett fungerande Selenium-skript och matchar
 * bokabord.se:s Angular-widget exakt:
 *   1. Välj erfarenhetstyp (middag)
 *   2. Välj antal gäster
 *   3. Navigera kalender → klicka datum
 *   4. Expandera tidslucka (click li) → klicka intern a.book-knapp
 *   5. Fyll i formulär (firstname / lastname / .guestPhone / email)
 *   6. Klicka bekräftelseknapp i ConsumerConfirmationHeader
 *   7. Avfärda eventuell extra dialog (cancel-btn)
 *   8. Slutbekräfta (Button--primary)
 */
async function autoBook(restaurantId, dateStr, guests, timeStr, user) {
  const config = RESTAURANTS[restaurantId];
  if (!config) throw new Error(`Unknown restaurant: ${restaurantId}`);

  const [year, month, day] = dateStr.split('-').map(Number);
  const domain = config.domain || 'app.bokabord.se';
  const url = `https://${domain}/reservation/?hash=${config.hash}&version=new&lang=sv`;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Steg 1: Erfarenhetstyp (föredrar "middag", faller tillbaka på första li)
    await page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('.ExperiencesList li'));
      const meal = lis.find(el => el.textContent.trim().toLowerCase().includes('middag')) || lis[0];
      if (meal) meal.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(2000);

    // Steg 2: Antal gäster (index = guests - 1, samma som Selenium-skriptet)
    await page.evaluate((g) => {
      const lis = Array.from(document.querySelectorAll('.SizesList li'));
      const target = lis[g - 1] || lis.find(el => el.textContent.trim() === String(g));
      if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, guests);

    await page.waitForSelector('.ConsumerCalendar', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Steg 3: Navigera till rätt månad
    for (let pass = 0; pass < 6; pass++) {
      const monthVisible = await page.evaluate(({ targetYear, targetMonth, MONTHS }) => {
        for (const container of document.querySelectorAll('.ConsumerCalendar-month')) {
          const heading = container.querySelector('.ConsumerCalendar-monthHeading');
          if (!heading) continue;
          const match = heading.textContent.trim().match(/(\w+)\s+(\d{4})/);
          if (!match) continue;
          if (MONTHS[match[1]] === targetMonth && parseInt(match[2]) === targetYear) return true;
        }
        return false;
      }, { targetYear: year, targetMonth: month, MONTHS: MONTH_MAP });

      if (monthVisible) break;

      const navigated = await page.evaluate(() => {
        const headingBtns = Array.from(document.querySelectorAll('.ConsumerCalendar-monthHeading button'));
        const ngClickEls = Array.from(document.querySelectorAll('[ng-click*="next"], [ng-click*="Next"], [ng-click*="forward"]'));
        for (const el of [...headingBtns, ...ngClickEls]) {
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

    // Steg 4: Klicka rätt datum
    const clicked = await page.evaluate(({ targetYear, targetMonth, targetDay, MONTHS }) => {
      for (const container of document.querySelectorAll('.ConsumerCalendar-month')) {
        const heading = container.querySelector('.ConsumerCalendar-monthHeading');
        if (!heading) continue;
        const match = heading.textContent.trim().match(/(\w+)\s+(\d{4})/);
        if (!match) continue;
        if (MONTHS[match[1]] !== targetMonth || parseInt(match[2]) !== targetYear) continue;
        for (const dayEl of container.querySelectorAll('.ConsumerCalendar-day')) {
          if (dayEl.className.includes('is-out-of-month') || dayEl.className.includes('is-disabled')) continue;
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
      console.warn(`[autoBook] ${restaurantId} datum ${dateStr} ej klickbart`);
      return { success: false, reason: 'date_unavailable' };
    }

    await page.waitForTimeout(2000);

    // Steg 5: Hitta rätt tidslucka — kontrollera att waitlist-knappen INTE syns (= ledigt)
    const timeItems = page.locator('li.TimesList-item');
    const count = await timeItems.count();
    let targetLi = null;

    for (let i = 0; i < count; i++) {
      const li = timeItems.nth(i);
      const timeEl = li.locator('.TimesList-itemTime');
      const timeText = await timeEl.textContent().catch(() => '');
      if (timeText.trim() !== timeStr) continue;

      // Ledigt om waitlist-knappen är dold (matchar Selenium-skriptets logik)
      const waitlistBtn = li.locator('.TimeList-addtoWaitlist');
      const waitlistVisible = await waitlistBtn.isVisible().catch(() => false);
      if (waitlistVisible) {
        console.warn(`[autoBook] ${timeStr} har köplats, ej ledigt`);
        return { success: false, reason: 'time_unavailable' };
      }
      targetLi = li;
      break;
    }

    if (!targetLi) {
      console.warn(`[autoBook] ${restaurantId} tid ${timeStr} hittades inte`);
      return { success: false, reason: 'time_not_found' };
    }

    // Steg 6: Expandera tidsluckan (klicka li) → klicka den inre a.book-knappen
    await targetLi.click({ timeout: 5000 });
    await page.waitForTimeout(1000);

    const bookBtn = targetLi.locator('a.book').first();
    if (await bookBtn.count() === 0) {
      console.warn(`[autoBook] ${restaurantId} ingen a.book-knapp hittad`);
      return { success: false, reason: 'no_book_button' };
    }
    await bookBtn.click({ timeout: 5000 });
    await page.waitForTimeout(5000);

    // Steg 7: Fyll i formuläret
    await page.fill('input[name="firstname"]', user.firstName);
    await page.fill('input[name="lastname"]', user.lastName);
    // .guestPhone är telefonfältet (bekräftat av Selenium-skriptet)
    await page.locator('.guestPhone').fill(user.phone || '').catch(() => {});
    await page.fill('input[name="email"]', user.email);

    await page.waitForTimeout(5000);

    // Steg 8: Bekräftelseknapp inuti ConsumerConfirmationHeader
    const confirmBtn = page.locator('.ConsumerConfirmationHeader .Button').first();
    if (await confirmBtn.count() === 0) {
      console.warn(`[autoBook] Ingen bekräftelseknapp hittad`);
      return { success: false, reason: 'no_confirm_button' };
    }
    await confirmBtn.click({ timeout: 5000 });
    await page.waitForTimeout(5000);

    // Steg 9: Avfärda eventuell extra dialog (t.ex. villkorsprompt)
    await page.locator('.cancel-btn').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // Steg 10: Slutbekräfta
    await page.locator('.Button--primary').click({ timeout: 5000 });
    await page.waitForTimeout(5000);

    // Steg 11: Kontrollera om bokning lyckades (formuläret borta eller bekräftelsetext)
    const success = await page.evaluate(() => {
      const txt = (document.body.innerText || '').toLowerCase();
      const formGone = document.querySelectorAll('input[name="firstname"]').length === 0;
      const hasConfirmText = txt.includes('tack') || txt.includes('bekräft') ||
                             txt.includes('confirmation') || txt.includes('thank');
      return formGone || hasConfirmText;
    });

    console.log(`[autoBook] ${restaurantId} ${dateStr} ${timeStr} — ${success ? 'LYCKADES' : 'MISSLYCKADES'}`);
    return { success, reason: success ? 'booked' : 'form_error' };

  } finally {
    await browser.close();
  }
}

module.exports = { scrapeBokabord, scrapeTimeslots, autoBook };
