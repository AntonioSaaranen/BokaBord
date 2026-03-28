'use strict';

const API_BASE = 'http://localhost:3000/api';

// Live availability data fetched from the scraper API
// Falls back to simulated data if server is not running
const liveAvailability = {}; // { restaurantId: { 'YYYY-MM-DD': status } }

async function fetchAvailability(restaurantId) {
  setCardLoading(restaurantId, true);
  try {
    const res = await fetch(`${API_BASE}/availability/${restaurantId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.availability && Object.keys(data.availability).length > 0) {
      liveAvailability[restaurantId] = data.availability;
      console.log(`[${restaurantId}] loaded ${Object.keys(data.availability).length} dates from API`);
      setCardLoading(restaurantId, false);
      setCardSource(restaurantId, 'live');
      return true;
    }
  } catch (err) {
    console.warn(`[${restaurantId}] API unavailable, using simulated data:`, err.message);
  }
  setCardLoading(restaurantId, false);
  setCardSource(restaurantId, 'simulated');
  return false;
}

function setCardLoading(restaurantId, loading) {
  const card = document.getElementById(restaurantId);
  if (!card) return;
  card.classList.toggle('cal-loading', loading);
}

function setCardSource(restaurantId, source) {
  const card = document.getElementById(restaurantId);
  if (!card) return;
  const badge = card.querySelector('.source-badge');
  if (!badge) return;
  badge.dataset.source = source;
  badge.textContent = source === 'live' ? 'Live' : 'Simulerat';
}

const RESTAURANTS = [
  {
    id: 'ekstedt',
    name: 'Ekstedt',
    cuisine: 'Nordisk · Vedeldad',
    desc: 'Bjorn Frantzéns unika kök tillagas enbart med öppen eld, hett järn och rök. En av Stockholms mest originella upplevelser.',
    bookingUrl: 'https://www.ekstedt.nu/reservations',
    closedDays: [0, 1], // Sun + Mon
    times: ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'],
    popularity: 0.75,
  },
  {
    id: 'oaxen-krog',
    name: 'Oaxen Krog',
    cuisine: 'Nordisk · 2 Michelin-stjärnor',
    desc: 'Magnus Eks och Agneta Greens hållbara krog på Djurgården. Djup råvarukunskap och nordisk elegans i vackra lokaler vid vattnet.',
    bookingUrl: 'https://www.oaxen.com/en/reservations/',
    closedDays: [0, 1, 2], // Sun + Mon + Tue
    times: ['18:00', '18:30', '19:00', '19:30', '20:00'],
    popularity: 0.8,
  },
  {
    id: 'lilla-ego',
    name: 'Lilla Ego',
    cuisine: 'Bistro · Säsongsmat',
    desc: 'Folklig bistro med fokus på svenska råvaror och klassiska tekniker. En av Stockholms mest omtyckta krogar.',
    bookingUrl: 'https://app.bokabord.se/reservation/?hash=a6ec81a26b9ea18ff9ba9852b8dcaa0b&version=new&lang=sv',
    closedDays: [1], // Monday
    times: ['17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'],
    // Popularity: higher = harder to get
    popularity: 0.6,
  },
  {
    id: 'hantverket',
    name: 'Hantverket',
    cuisine: 'Nordisk · Hantverkskök',
    desc: 'Restaurang i ett anrikt kvarter med nordisk husmanskost och ett brett urval av hantverksbryggda öl.',
    bookingUrl: 'https://restauranghantverket.se/en/reservations',
    closedDays: [0], // Sunday
    times: ['12:00', '12:30', '13:00', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'],
    popularity: 0.5,
  },
  {
    id: 'frantzen',
    name: 'Frantzén',
    cuisine: 'Fine Dining · 3 Michelin-stjärnor',
    desc: 'Ett av Nordens mest hyllade matupplevelserna. Borden öppnas den 1:a varje månad kl 10:00.',
    bookingUrl: 'https://www.restaurantfrantzen.com/',
    closedDays: [0, 1], // Sun + Mon
    times: ['18:00', '18:30', '19:00'],
    popularity: 0.92,
    note: 'Bord släpps den 1:a varje månad kl 10:00 CET',
  },
];

const WEEKDAYS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
// Months in Swedish
const MONTHS_SV = [
  'Januari','Februari','Mars','April','Maj','Juni',
  'Juli','Augusti','September','Oktober','November','December'
];
const DAYS_SV = ['söndag','måndag','tisdag','onsdag','torsdag','fredag','lördag'];

// Seeded pseudo-random so calendar looks consistent per session
function seededRand(seed) {
  let x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

function getAvailability(restaurantId, date, popularity) {
  // Use live data if available
  const live = liveAvailability[restaurantId];
  if (live) {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const status = live[key];
    if (status && status !== 'unknown') return status;
  }
  // Simulated fallback
  const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
    + restaurantId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const r = seededRand(seed);
  if (r < popularity * 0.55) return 'full';
  if (r < popularity * 0.75) return 'scarce';
  return 'available';
}

function getTimeSlots(restaurant, date) {
  return restaurant.times.map((t, i) => {
    const seed = date.getFullYear() * 100000 + (date.getMonth() + 1) * 1000
      + date.getDate() * 10 + i
      + restaurant.id.charCodeAt(0);
    const r = seededRand(seed);
    let status;
    if (r < restaurant.popularity * 0.6) status = 'booked';
    else if (r < restaurant.popularity * 0.8) status = 'limited';
    else status = 'open';
    return { time: t, status };
  });
}

function buildCalendar(restaurant, monthOffset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const base = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = base.getFullYear();
  const month = base.getMonth();

  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  // Weekday headers
  WEEKDAYS.forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-weekday';
    el.textContent = d;
    grid.appendChild(el);
  });

  // Empty cells before first day
  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-day empty';
    grid.appendChild(el);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dow = date.getDay(); // 0=Sun
    const el = document.createElement('div');

    const isPast = date < today;
    const isClosed = restaurant.closedDays.includes(dow);
    const isToday = date.getTime() === today.getTime();

    const numEl = document.createElement('span');
    numEl.className = 'day-num';
    numEl.textContent = d;
    el.appendChild(numEl);

    if (isPast) {
      el.className = 'cal-day past';
    } else if (isClosed) {
      el.className = 'cal-day closed';
      const dot = document.createElement('span');
      dot.className = 'dot';
      el.appendChild(dot);
    } else {
      const avail = getAvailability(restaurant.id, date, restaurant.popularity);
      el.className = 'cal-day ' + avail;
      const dot = document.createElement('span');
      dot.className = 'dot';
      el.appendChild(dot);

      if (avail !== 'full') {
        el.addEventListener('click', () => openModal(restaurant, date));
      }
    }

    if (isToday) el.classList.add('today');
    grid.appendChild(el);
  }

  return grid;
}

function buildRestaurantCard(restaurant) {
  const today = new Date();

  const card = document.createElement('article');
  card.className = 'restaurant';
  card.id = restaurant.id;

  // Header
  const header = document.createElement('div');
  header.className = 'restaurant-header';

  const meta = document.createElement('div');
  meta.className = 'restaurant-meta';
  meta.innerHTML = `
    <h2>${restaurant.name}</h2>
    <div class="cuisine">${restaurant.cuisine}</div>
    <div class="desc">${restaurant.desc}</div>
  `;
  const sourceBadge = document.createElement('span');
  sourceBadge.className = 'source-badge';
  sourceBadge.dataset.source = 'loading';
  sourceBadge.textContent = 'Hämtar…';
  meta.appendChild(sourceBadge);

  const bookBtn = document.createElement('a');
  bookBtn.className = 'book-btn';
  bookBtn.href = restaurant.bookingUrl;
  bookBtn.target = '_blank';
  bookBtn.rel = 'noopener noreferrer';
  bookBtn.textContent = 'Boka bord';

  header.appendChild(meta);
  header.appendChild(bookBtn);
  card.appendChild(header);

  // Calendar section
  const calSection = document.createElement('div');
  calSection.className = 'calendar-section';

  // Month tabs
  const nav = document.createElement('div');
  nav.className = 'calendar-nav';
  const tabs = document.createElement('div');
  tabs.className = 'calendar-tabs';

  const months = [0, 1, 2].map(offset => {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    return { offset, label: MONTHS_SV[d.getMonth()] + ' ' + d.getFullYear() };
  });

  const calWrapper = document.createElement('div');
  calWrapper.className = 'calendar-wrapper';

  let activeOffset = 0;

  function showMonth(offset) {
    activeOffset = offset;
    tabs.querySelectorAll('.tab-btn').forEach((btn, i) => {
      btn.classList.toggle('active', i === offset);
    });
    calWrapper.innerHTML = '';
    calWrapper.appendChild(buildCalendar(restaurant, offset));
  }

  months.forEach(({ offset, label }) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (offset === 0 ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => showMonth(offset));
    tabs.appendChild(btn);
  });

  nav.appendChild(tabs);
  calSection.appendChild(nav);
  calSection.appendChild(calWrapper);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `
    <div class="legend-item"><div class="legend-dot" style="background:var(--available)"></div> Lediga bord</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--scarce)"></div> Sista platser</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--full)"></div> Fullbokat</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--closed)"></div> Stängt</div>
  `;
  calSection.appendChild(legend);

  const spinner = document.createElement('div');
  spinner.className = 'cal-spinner';
  calSection.appendChild(spinner);

  card.appendChild(calSection);

  showMonth(0);
  return card;
}

// Modal
function formatDateSv(date) {
  return DAYS_SV[date.getDay()] + ' ' + date.getDate() + ' '
    + MONTHS_SV[date.getMonth()].toLowerCase() + ' ' + date.getFullYear();
}

let modalGuestCount = 2;

function openModal(restaurant, date) {
  modalGuestCount = 2;
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');
  const slots = getTimeSlots(restaurant, date);

  const slotsHtml = slots.map(s =>
    `<div class="time-slot ${s.status}">${s.time}${s.status === 'limited' ? '<br><small>Sista</small>' : ''}</div>`
  ).join('');

  const noteHtml = restaurant.note
    ? `<p class="modal-note">${restaurant.note}</p>`
    : '';

  content.innerHTML = `
    <div class="modal-date">${formatDateSv(date)}</div>
    <div class="modal-restaurant">${restaurant.name}</div>
    <div class="guest-picker">
      <span class="guest-label">Antal gäster</span>
      <div class="guest-controls">
        <button class="guest-btn" id="guest-dec">−</button>
        <span class="guest-num" id="guest-count">2</span>
        <button class="guest-btn" id="guest-inc">+</button>
      </div>
    </div>
    <div class="time-slots">${slotsHtml}</div>
    <a class="modal-book-btn" href="${restaurant.bookingUrl}" target="_blank" rel="noopener noreferrer">
      Gå till bokning
    </a>
    ${noteHtml}
  `;

  document.getElementById('guest-dec').addEventListener('click', () => {
    if (modalGuestCount > 1) {
      modalGuestCount--;
      document.getElementById('guest-count').textContent = modalGuestCount;
    }
  });
  document.getElementById('guest-inc').addEventListener('click', () => {
    if (modalGuestCount < 10) {
      modalGuestCount++;
      document.getElementById('guest-count').textContent = modalGuestCount;
    }
  });

  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// Render all restaurants, then fetch live data and refresh calendars
const container = document.getElementById('restaurants');
RESTAURANTS.forEach(r => container.appendChild(buildRestaurantCard(r)));

// Fetch live availability and re-render calendars when data arrives
RESTAURANTS.forEach(async (r) => {
  const fetched = await fetchAvailability(r.id);
  if (fetched) {
    // Re-render the active month calendar for this restaurant
    const card = document.getElementById(r.id);
    if (!card) return;
    const tabs = card.querySelectorAll('.tab-btn');
    const activeTab = [...tabs].findIndex(t => t.classList.contains('active'));
    tabs[activeTab >= 0 ? activeTab : 0]?.click();
  }
});
