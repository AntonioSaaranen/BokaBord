'use strict';

const fs = require('fs');
const path = require('path');
const { scrapeTimeslots, autoBook } = require('./scrapers/bokabord');

const FILE = path.join(__dirname, 'watchlist.json');
const POLL_MS = 5 * 60 * 1000;

let entries = [];
let pendingAlerts = [];

const BOOKING_URLS = {
  'lilla-ego': 'https://app.bokabord.se/reservation/?hash=a6ec81a26b9ea18ff9ba9852b8dcaa0b&version=new&lang=sv',
  'hantverket': 'https://restauranghantverket.se/en/reservations',
  'ag':         'https://beta.waiteraid.com/reservation/?hash=29f087bafdf8723d0918d6ed5bdf7b06&version=new&lang=sv',
  'frantzen':   'https://app.bokabord.se/reservation/?hash=77779be66a85c01c2efe78905bbf67e9&version=new&lang=sv',
};

function load() {
  try {
    if (fs.existsSync(FILE)) entries = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { entries = []; }
}

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(entries, null, 2)); } catch {}
}

function add(data) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = { ...data, id, status: 'watching', createdAt: new Date().toISOString() };
  entries.push(entry);
  save();
  setTimeout(() => checkEntry(entry), 500); // immediate check
  return id;
}

function remove(id) {
  entries = entries.filter(e => e.id !== id);
  save();
}

function getAll() { return entries; }

function popAlerts() {
  const result = [...pendingAlerts];
  pendingAlerts = [];
  return result;
}

async function checkEntry(entry) {
  if (entry.status !== 'watching') return;

  try {
    const result = await scrapeTimeslots(entry.restaurantId, entry.date, entry.guests);
    let open = result.slots.filter(s => s.status === 'open');

    if (entry.preferredTimes && entry.preferredTimes.length > 0) {
      open = open.filter(s => entry.preferredTimes.includes(s.time));
    }

    if (open.length > 0) {
      console.log(`[watchlist] HITTAT! ${entry.restaurantId} ${entry.date} — ${open.map(s => s.time).join(', ')}`);

      const alertBase = {
        id: Date.now().toString(),
        entryId: entry.id,
        restaurantId: entry.restaurantId,
        restaurantName: entry.restaurantName,
        date: entry.date,
        slots: open,
        guests: entry.guests,
        user: { firstName: entry.firstName, lastName: entry.lastName, email: entry.email, phone: entry.phone },
        bookingUrl: BOOKING_URLS[entry.restaurantId] || '#',
        foundAt: new Date().toISOString(),
      };

      if (entry.autoBook && entry.firstName && entry.lastName && entry.email) {
        // Försök boka automatiskt den första lediga tid
        const targetSlot = open[0];
        console.log(`[watchlist] Försöker autoboka ${entry.restaurantId} ${entry.date} ${targetSlot.time}...`);
        try {
          const result = await autoBook(
            entry.restaurantId, entry.date, entry.guests, targetSlot.time,
            { firstName: entry.firstName, lastName: entry.lastName, email: entry.email, phone: entry.phone }
          );
          if (result.success) {
            entry.status = 'booked';
            entry.bookedAt = new Date().toISOString();
            entry.bookedTime = targetSlot.time;
            pendingAlerts.push({ ...alertBase, autoBooked: true, bookedTime: targetSlot.time });
            console.log(`[watchlist] Autobokning lyckades! ${entry.restaurantId} ${entry.date} ${targetSlot.time}`);
          } else {
            // Autobokning misslyckades — meddela ändå
            entry.status = 'found';
            entry.foundAt = new Date().toISOString();
            pendingAlerts.push({ ...alertBase, autoBooked: false, autoBookFailed: true });
            console.warn(`[watchlist] Autobokning misslyckades (${result.reason}), skickar manuell varning`);
          }
        } catch (bookErr) {
          entry.status = 'found';
          entry.foundAt = new Date().toISOString();
          pendingAlerts.push({ ...alertBase, autoBooked: false, autoBookFailed: true });
          console.error(`[watchlist] Autobokning fel:`, bookErr.message);
        }
      } else {
        pendingAlerts.push({ ...alertBase, autoBooked: false });
        entry.status = 'found';
        entry.foundAt = new Date().toISOString();
      }
      save();
    }
  } catch (err) {
    console.error(`[watchlist] Fel ${entry.restaurantId} ${entry.date}:`, err.message);
  }
}

async function pollAll() {
  const watching = entries.filter(e => e.status === 'watching');
  if (!watching.length) return;
  console.log(`[watchlist] Kollar ${watching.length} bevakning(ar)...`);
  for (const entry of watching) {
    await checkEntry(entry);
    await new Promise(r => setTimeout(r, 2000));
  }
}

function start() {
  load();
  const active = entries.filter(e => e.status === 'watching').length;
  console.log(`[watchlist] ${active} aktiva bevakningar`);
  if (active) pollAll();
  setInterval(pollAll, POLL_MS);
}

module.exports = { start, add, remove, getAll, popAlerts };
