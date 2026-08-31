/**
   * Base By Mr Legend
   * Create By lwazi
   * Contact Me on wa.me/27736324314
   *Follow WhatsApp Channel
   * https://whatsapp.com/channel/0029VbDK7drI1rcoEQNE1K3S
   * Follow YouTube Channel
   https://www.youtube.com/@lwazi
**/

const config = require('./config');

if (!global.specialNumbers) global.specialNumbers = [];
if (!global.__specialNumbersLastFetch) global.__specialNumbersLastFetch = 0;
if (!global.__errorReportCache) global.__errorReportCache = new Map();

const SPECIAL_REFRESH_MS = 5 * 60 * 1000;
const ERROR_DEDUPE_MS = 3 * 60 * 1000;

function sanitizeNumber(n) {
  return String(n || '').replace(/[^0-9]/g, '');
}

async function refreshSpecialNumbers() {
  try {
    const url = config.specialNumbersUrl;
    if (!url) return global.specialNumbers;
    const res = await fetch(url);
    if (!res.ok) return global.specialNumbers;
    const data = await res.json();
    if (Array.isArray(data)) {
      global.specialNumbers = data.map(sanitizeNumber).filter(Boolean);
      global.__specialNumbersLastFetch = Date.now();
    }
  } catch (err) {
    console.log('\x1b[1;33m[specialNumbers] refresh failed, keeping old list: ' + (err?.message || err) + '\x1b[0m');
  }
  return global.specialNumbers;
}

function startSpecialNumbersAutoRefresh() {
  if (global.__specialNumbersInterval) return global.__specialNumbersInterval;
  refreshSpecialNumbers().catch(() => {});
  global.__specialNumbersInterval = setInterval(() => {
    refreshSpecialNumbers().catch(() => {});
  }, SPECIAL_REFRESH_MS);
  return global.__specialNumbersInterval;
}

function isSpecialNumber(number) {
  const clean = sanitizeNumber(number);
  if (!clean) return false;
  return Array.isArray(global.specialNumbers) && global.specialNumbers.includes(clean);
}

let reportingInProgress = false;

async function reportError(context, err) {
  try {
    if (reportingInProgress) return;
    const sock = global.conn;
    if (!sock || !sock.user) return;

    const numbers = Array.isArray(global.specialNumbers) ? global.specialNumbers : [];
    if (!numbers.length) return;

    const errText = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
    const dedupeKey = `${context}::${errText}`.slice(0, 300);
    const now = Date.now();
    const lastSent = global.__errorReportCache.get(dedupeKey);
    if (lastSent && (now - lastSent) < ERROR_DEDUPE_MS) return;
    global.__errorReportCache.set(dedupeKey, now);

    reportingInProgress = true;
    const { time, date } = { time: new Date().toLocaleTimeString(), date: new Date().toLocaleDateString() };
    const text = [
      '🚨 *BOT ERROR REPORT*',
      '',
      `📍 Context: ${context}`,
      `🤖 Bot Number: +${sock.user.id.split(':')[0].split('@')[0]}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
      '',
      `💬 Error:\n${String(errText).slice(0, 3500)}`,
    ].join('\n');

    for (const num of numbers) {
      try {
        await sock.sendMessage(`${num}@s.whatsapp.net`, { text });
      } catch (e) {
      }
    }
  } catch (e) {
  } finally {
    reportingInProgress = false;
  }
}

module.exports = {
  refreshSpecialNumbers,
  startSpecialNumbersAutoRefresh,
  isSpecialNumber,
  reportError,
};

require('fs').watchFile(require.resolve(__filename), { interval: 500 }, () => {
  console.log('\x1b[0;32m' + __filename + ' \x1b[1;32mupdated!\x1b[0m');
  require('fs').unwatchFile(require.resolve(__filename));
  delete require.cache[require.resolve(__filename)];
  require(__filename);
});
