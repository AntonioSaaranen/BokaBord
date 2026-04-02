'use strict';

const API_BASE = 'http://localhost:3000/api';

// ── State ────────────────────────────────────────────────────────────
const liveAvailability = {};
const fetchState = {}; // 'loading' | 'live' | 'simulated'
let currentRestaurantId = 'lilla-ego';
let currentGuests = 2;
let activeMonthOffset = 0;

// ── Restaurant data ──────────────────────────────────────────────────
const RESTAURANTS = [
  {
    id: 'lilla-ego',
    name: 'Lilla Ego',
    cuisine: 'Bistro · Säsongsmat',
    desc: 'Folklig bistro med fokus på svenska råvaror och klassiska tekniker. En av Stockholms mest omtyckta krogar.',
    bookingUrl: 'https://app.bokabord.se/reservation/?hash=a6ec81a26b9ea18ff9ba9852b8dcaa0b&version=new&lang=sv',
    closedDays: [1],
    popularity: 0.6,
  },
  {
    id: 'hantverket',
    name: 'Hantverket',
    cuisine: 'Nordisk · Hantverkskök',
    desc: 'Restaurang i ett anrikt kvarter med nordisk husmanskost och ett brett urval av hantverksbryggda öl.',
    bookingUrl: 'https://restauranghantverket.se/en/reservations',
    closedDays: [0],
    popularity: 0.5,
  },
  {
    id: 'ag',
    name: 'AG',
    cuisine: 'Steakhouse · Torkat kött & vin',
    desc: 'En av Stockholms mest hyllade steakhouses med fokus på torkat kött av hög kvalitet och naturviner i en imponerande källarmiljö under Gamla Stan.',
    bookingUrl: 'https://beta.waiteraid.com/reservation/?hash=29f087bafdf8723d0918d6ed5bdf7b06&version=new&lang=sv',
    closedDays: [0],
    popularity: 0.72,
  },
  {
    id: 'ekstedt',
    name: 'Ekstedt',
    cuisine: 'Nordisk · Vedeldad',
    desc: 'Björn Frantzéns unika kök tillagas enbart med öppen eld, hett järn och rök. En av Stockholms mest originella upplevelser.',
    bookingUrl: 'https://www.ekstedt.nu/reservations',
    closedDays: [0, 1],
    popularity: 0.75,
  },
  {
    id: 'oaxen-krog',
    name: 'Oaxen Krog',
    cuisine: 'Nordisk · 2 Michelin-stjärnor',
    desc: 'Magnus Eks och Agneta Greens hållbara krog på Djurgården. Djup råvarukunskap och nordisk elegans i vackra lokaler vid vattnet.',
    bookingUrl: 'https://www.oaxen.com/en/reservations/',
    closedDays: [0, 1, 2],
    popularity: 0.8,
  },
  {
    id: 'frantzen',
    name: 'Frantzén',
    cuisine: 'Fine Dining · 3 Michelin-stjärnor',
    desc: 'Ett av Nordens mest hyllade matupplevelserna med en unik omakase-upplevelse i hjärtat av Stockholm.',
    bookingUrl: 'https://app.bokabord.se/reservation/?hash=77779be66a85c01c2efe78905bbf67e9&version=new&lang=sv',
    closedDays: [0, 1],
    popularity: 0.92,
    note: 'Bord släpps den 1:a varje månad kl 10:00 CET',
  },
];

// ── Constants ────────────────────────────────────────────────────────
const WEEKDAYS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
const MONTHS_SV = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
];
const DAYS_SV = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
const TIMESLOT_SUPPORTED = ['lilla-ego', 'hantverket', 'ag', 'frantzen'];

// ── Availability helpers ─────────────────────────────────────────────
function seededRand(seed) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

function getAvailability(restaurantId, date, popularity) {
  const live = liveAvailability[restaurantId];
  if (live) {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const status = live[key];
    if (status && status !== 'unknown') return status;
  }
  const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
    + restaurantId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const r = seededRand(seed);
  if (r < popularity * 0.55) return 'full';
  if (r < popularity * 0.75) return 'scarce';
  return 'available';
}

// ── Fetch live data ──────────────────────────────────────────────────
async function fetchAvailability(restaurantId) {
  fetchState[restaurantId] = 'loading';
  try {
    const res = await fetch(`${API_BASE}/availability/${restaurantId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.availability && Object.keys(data.availability).length > 0) {
      liveAvailability[restaurantId] = data.availability;
      fetchState[restaurantId] = 'live';
    } else {
      fetchState[restaurantId] = 'simulated';
    }
  } catch (err) {
    console.warn(`[${restaurantId}] API error:`, err.message);
    fetchState[restaurantId] = 'simulated';
  }
  if (restaurantId === currentRestaurantId) {
    updatePanelBadge();
    refreshCalendar();
  }
}

// ── Sidebar ──────────────────────────────────────────────────────────
function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  RESTAURANTS.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'rest-item' + (r.id === currentRestaurantId ? ' active' : '');
    btn.dataset.id = r.id;
    btn.innerHTML = `
      <div class="rest-item-name">${r.name}</div>
      <div class="rest-item-cuisine">${r.cuisine}</div>
    `;
    btn.addEventListener('click', () => selectRestaurant(r.id));
    sidebar.appendChild(btn);
  });
}

function selectRestaurant(id) {
  currentRestaurantId = id;
  activeMonthOffset = 0;
  document.querySelectorAll('.rest-item').forEach(b => {
    b.classList.toggle('active', b.dataset.id === id);
  });
  renderPanel();
}

// ── Guest picker ─────────────────────────────────────────────────────
function renderGuestPicker() {
  const container = document.getElementById('guest-btns');
  [1, 2, 3, 4, 5, 6, 7, 8].forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'guest-btn' + (n === currentGuests ? ' active' : '');
    btn.textContent = n;
    btn.addEventListener('click', () => setGuests(n));
    container.appendChild(btn);
  });
}

function setGuests(n) {
  currentGuests = n;
  document.querySelectorAll('#guest-btns .guest-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.textContent) === n);
  });
}

// ── Panel ─────────────────────────────────────────────────────────────
function renderPanel() {
  const restaurant = RESTAURANTS.find(r => r.id === currentRestaurantId);

  document.querySelector('.panel-name').textContent = restaurant.name;
  document.querySelector('.panel-cuisine').textContent = restaurant.cuisine;
  document.querySelector('.panel-desc').textContent = restaurant.desc;
  document.querySelector('.panel-book-btn').href = restaurant.bookingUrl;

  const noteEl = document.querySelector('.panel-note');
  if (restaurant.note) {
    noteEl.textContent = restaurant.note;
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  updatePanelBadge();
  renderCalendarTabs(restaurant);
}

function updatePanelBadge() {
  const badge = document.getElementById('panel-badge');
  const state = fetchState[currentRestaurantId] || 'loading';
  badge.dataset.source = state;
  badge.textContent = state === 'live' ? 'Live' : state === 'simulated' ? 'Simulerat' : 'Hämtar…';
}

// ── Calendar ──────────────────────────────────────────────────────────
function renderCalendarTabs(restaurant) {
  const today = new Date();
  const tabs = document.getElementById('cal-tabs');
  tabs.innerHTML = '';

  [0, 1].forEach(offset => {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (offset === activeMonthOffset ? ' active' : '');
    btn.textContent = MONTHS_SV[d.getMonth()] + ' ' + d.getFullYear();
    btn.addEventListener('click', () => {
      activeMonthOffset = offset;
      tabs.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === offset));
      refreshCalendar();
    });
    tabs.appendChild(btn);
  });

  refreshCalendar();
}

function refreshCalendar() {
  const restaurant = RESTAURANTS.find(r => r.id === currentRestaurantId);
  const wrapper = document.getElementById('cal-wrapper');
  wrapper.innerHTML = '';
  wrapper.appendChild(buildCalendar(restaurant, activeMonthOffset));
}

function buildCalendar(restaurant, monthOffset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const base = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = base.getFullYear();
  const month = base.getMonth();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  WEEKDAYS.forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-weekday';
    el.textContent = d;
    grid.appendChild(el);
  });

  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-day empty';
    grid.appendChild(el);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dow = date.getDay();
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
    } else {
      const avail = getAvailability(restaurant.id, date, restaurant.popularity);
      el.className = 'cal-day ' + avail;
      if (avail !== 'full') {
        el.addEventListener('click', () => openModal(restaurant, date));
      }
    }

    if (isToday) el.classList.add('today');
    grid.appendChild(el);
  }

  return grid;
}

// ── Modal ─────────────────────────────────────────────────────────────
function formatDateSv(date) {
  return DAYS_SV[date.getDay()] + ' ' + date.getDate() + ' '
    + MONTHS_SV[date.getMonth()].toLowerCase() + ' ' + date.getFullYear();
}

async function fetchModalTimeslots(restaurant, date, guests, container) {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  container.innerHTML = '<div class="slots-loading">Hämtar tider…</div>';
  try {
    const res = await fetch(`${API_BASE}/timeslots/${restaurant.id}?date=${dateStr}&guests=${guests}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const openSlots = (data.slots || []).filter(s => s.status === 'open');
    if (openSlots.length === 0) {
      container.innerHTML = '<div class="no-slots">Inga lediga tider — fullt bokat.</div>';
    } else {
      container.innerHTML = openSlots.map(s => `<span class="time-slot open">${s.time}</span>`).join('');
    }
  } catch (err) {
    console.warn(`[timeslots] ${restaurant.id}:`, err.message);
    container.innerHTML = '<div class="no-slots">Kunde inte hämta tider.</div>';
  }
}

function openModal(restaurant, date) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');
  const isLive = !!liveAvailability[restaurant.id];
  const hasTimeslots = TIMESLOT_SUPPORTED.includes(restaurant.id);

  const noteHtml = restaurant.note ? `<p class="modal-note">${restaurant.note}</p>` : '';
  const dataNote = isLive
    ? `<p class="modal-note">Tillgänglighet hämtad direkt från bokningssidan.</p>`
    : `<p class="modal-note">Indikativ tillgänglighet — kontrollera alltid på bokningssidan.</p>`;

  const guestPickerHtml = hasTimeslots ? `
    <div class="modal-guest-picker">
      <span class="modal-guest-label">Antal gäster:</span>
      ${[1, 2, 3, 4, 5, 6].map(n =>
        `<button class="guest-btn${n === currentGuests ? ' active' : ''}" data-guests="${n}">${n}</button>`
      ).join('')}
    </div>
    <div class="time-slots-container"></div>
  ` : '';

  const watchlistHtml = TIMESLOT_SUPPORTED.includes(restaurant.id) ? watchlistFormHtml(restaurant, date) : '';

  content.innerHTML = `
    <div class="modal-date">${formatDateSv(date)}</div>
    <div class="modal-restaurant">${restaurant.name}</div>
    <a class="modal-book-btn" href="${restaurant.bookingUrl}" target="_blank" rel="noopener noreferrer">
      Se lediga tider &amp; boka
    </a>
    ${guestPickerHtml}
    ${noteHtml}
    ${dataNote}
    ${watchlistHtml}
  `;

  modal.classList.remove('hidden');

  if (hasTimeslots) {
    const slotsContainer = content.querySelector('.time-slots-container');
    fetchModalTimeslots(restaurant, date, currentGuests, slotsContainer);

    content.querySelectorAll('.guest-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        content.querySelectorAll('.guest-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const g = parseInt(btn.dataset.guests);
        setGuests(g);
        fetchModalTimeslots(restaurant, date, g, slotsContainer);
      });
    });
  }

  if (TIMESLOT_SUPPORTED.includes(restaurant.id)) {
    initWatchlistSection(restaurant, date, currentGuests);
  }
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Watchlist ─────────────────────────────────────────────────────────

function watchlistFormHtml(restaurant, date) {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `
    <div class="watchlist-section">
      <button class="watchlist-toggle-btn">+ Bevaka detta datum</button>
      <form class="watchlist-form hidden" id="watchlist-form" novalidate>
        <input type="hidden" name="restaurantId" value="${restaurant.id}">
        <input type="hidden" name="restaurantName" value="${restaurant.name}">
        <input type="hidden" name="date" value="${dateStr}">
        <div class="watchlist-fields">
          <input class="wl-input" type="text" name="firstName" placeholder="Förnamn" required>
          <input class="wl-input" type="text" name="lastName" placeholder="Efternamn" required>
          <input class="wl-input" type="email" name="email" placeholder="E-post" required>
          <input class="wl-input" type="tel" name="phone" placeholder="Telefon (valfritt)">
        </div>
        <label class="wl-autobook-toggle">
          <input type="checkbox" name="autoBook">
          <span class="wl-autobook-label">Boka automatiskt när bord blir ledigt</span>
        </label>
        <div class="wl-times-section">
          <div class="wl-times-label">Bevaka tider (lämna tomt för alla):</div>
          <div class="wl-times-grid" id="wl-times-grid">
            <span class="wl-times-loading">Hämtar tider…</span>
          </div>
        </div>
        <div class="watchlist-form-actions">
          <button type="submit" class="wl-submit-btn">Bevaka</button>
          <button type="button" class="wl-cancel-btn">Avbryt</button>
        </div>
        <p class="watchlist-confirm hidden" id="watchlist-confirm">Bevakning tillagd! Vi meddelar dig när ett bord blir ledigt.</p>
      </form>
    </div>
  `;
}

async function loadWatchlistTimes(restaurant, date, guests, grid) {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  try {
    const res = await fetch(`${API_BASE}/timeslots/${restaurant.id}?date=${dateStr}&guests=${guests}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const slots = data.slots || [];
    if (slots.length === 0) {
      grid.innerHTML = '<span class="wl-times-loading">Inga tider tillgängliga.</span>';
      return;
    }
    grid.innerHTML = slots.map(s => `
      <label class="wl-time-label ${s.status}">
        <input type="checkbox" name="preferredTimes" value="${s.time}">
        ${s.time}
      </label>
    `).join('');
  } catch {
    grid.innerHTML = '<span class="wl-times-loading">Kunde inte hämta tider.</span>';
  }
}

function initWatchlistSection(restaurant, date, guests) {
  const content = document.getElementById('modal-content');
  const section = content.querySelector('.watchlist-section');
  if (!section) return;

  const toggleBtn = section.querySelector('.watchlist-toggle-btn');
  const form = section.querySelector('.watchlist-form');
  const cancelBtn = section.querySelector('.wl-cancel-btn');
  const confirm = section.querySelector('#watchlist-confirm');
  const timesGrid = section.querySelector('#wl-times-grid');
  let timesLoaded = false;

  toggleBtn.addEventListener('click', () => {
    form.classList.remove('hidden');
    toggleBtn.classList.add('hidden');
    if (!timesLoaded) {
      timesLoaded = true;
      loadWatchlistTimes(restaurant, date, guests, timesGrid);
    }
  });

  cancelBtn.addEventListener('click', () => {
    form.classList.add('hidden');
    toggleBtn.classList.remove('hidden');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const preferredTimes = fd.getAll('preferredTimes');
    const payload = {
      restaurantId: fd.get('restaurantId'),
      restaurantName: fd.get('restaurantName'),
      date: fd.get('date'),
      guests,
      preferredTimes: preferredTimes.length > 0 ? preferredTimes : null,
      firstName: fd.get('firstName'),
      lastName: fd.get('lastName'),
      email: fd.get('email'),
      phone: fd.get('phone') || null,
      autoBook: fd.get('autoBook') === 'on',
    };
    try {
      const res = await fetch(`${API_BASE}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      form.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"]').forEach(el => { el.value = ''; });
      form.querySelectorAll('input[type="checkbox"]').forEach(el => { el.checked = false; });
      const autoBookChecked = payload.autoBook;
      confirm.textContent = autoBookChecked
        ? 'Autobokning aktiverad! Bokar automatiskt när ett bord dyker upp.'
        : 'Bevakning tillagd! Vi meddelar dig när ett bord blir ledigt.';
      confirm.classList.remove('hidden');
      setTimeout(() => {
        form.classList.add('hidden');
        toggleBtn.classList.remove('hidden');
        confirm.classList.add('hidden');
      }, 3000);
    } catch (err) {
      console.warn('[watchlist] submit error:', err.message);
    }
  });
}

// ── Alert polling & toasts ────────────────────────────────────────────

function showToast(alert) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  const isAutoBooked = alert.autoBooked;
  const isAutoFailed = alert.autoBookFailed;
  toast.className = 'toast' + (isAutoBooked ? ' toast--booked' : '');
  const times = alert.slots.map(s => s.time).join(', ');
  const userName = [alert.user.firstName, alert.user.lastName].filter(Boolean).join(' ');
  const statusLine = isAutoBooked
    ? `<p class="toast-status toast-status--success">Bokat automatiskt: <strong>${alert.bookedTime}</strong></p>`
    : isAutoFailed
    ? `<p class="toast-status toast-status--warn">Autobokning misslyckades — boka manuellt</p>`
    : '';
  toast.innerHTML = `
    <div class="toast-header">
      <strong>${alert.restaurantName}</strong>
      <button class="toast-close">✕</button>
    </div>
    <div class="toast-body">
      ${statusLine}
      <p>${alert.date} — lediga tider: <strong>${times}</strong></p>
      <p class="toast-user">${userName} · ${alert.user.email}${alert.user.phone ? ' · ' + alert.user.phone : ''}</p>
      ${!isAutoBooked ? `<a class="toast-book-btn" href="${alert.bookingUrl}" target="_blank" rel="noopener noreferrer">Boka nu →</a>` : ''}
    </div>
  `;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, 60000);
}

async function pollAlerts() {
  try {
    const res = await fetch(`${API_BASE}/watchlist/alerts`);
    if (!res.ok) return;
    const { alerts } = await res.json();
    alerts.forEach(showToast);
  } catch {}
}

setInterval(pollAlerts, 60 * 1000);

// ── Boot ──────────────────────────────────────────────────────────────
renderSidebar();
renderGuestPicker();
renderPanel();
RESTAURANTS.forEach(r => fetchAvailability(r.id));
