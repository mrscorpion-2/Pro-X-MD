/**
   * Base By Mr Legend
   * Create By lwazi
   * Contact Me on wa.me/27736324314
   *Follow WhatsApp Channel
   * https://whatsapp.com/channel/0029VbDK7drI1rcoEQNE1K3S
   * Follow YouTube Channel
   https://www.youtube.com/@lwazi
**/

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const config = require('./config');
const { reply } = require('./menu');
const { normalizeMessageContent } = require('@whiskeysockets/baileys');
const { reportError, isSpecialNumber, startSpecialNumbersAutoRefresh } = require('./reports');

const PAIR_SESSION_ROOT = path.resolve('./pairsessions');
const logger = pino({ level: 'silent' });

const color = {
  reset: '\x1b[0m',
  green: '\x1b[1;32m',
  cyan: '\x1b[1;36m',
  yellow: '\x1b[1;33m',
  red: '\x1b[1;31m',
  magenta: '\x1b[1;35m',
  blue: '\x1b[1;34m',
};

process.on('uncaughtException', (err) => {
  console.log('\x1b[1;31m[uncaughtException] ' + (err?.stack || err) + '\x1b[0m');
  reportError('uncaughtException (pairbot)', err).catch(() => {});
});
process.on('unhandledRejection', (err) => {
  console.log('\x1b[1;31m[unhandledRejection] ' + (err?.stack || err) + '\x1b[0m');
  reportError('unhandledRejection (pairbot)', err).catch(() => {});
});
const activePairs = {};
const pairLidIntervals = {};
const pairAlwaysOnlineIntervals = {};

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sanitizeNumber(number) { return String(number || '').replace(/[^0-9]/g, ''); }
function getSessionPath(number) { return path.join(PAIR_SESSION_ROOT, number); }
function getAllSavedNumbers() {
  if (!fs.existsSync(PAIR_SESSION_ROOT)) return [];
  return fs.readdirSync(PAIR_SESSION_ROOT).filter((name) => {
    const full = path.join(PAIR_SESSION_ROOT, name);
    try { return fs.statSync(full).isDirectory(); } catch { return false; }
  });
}

async function startPairSocket(number, onCode) {
  const sessionFolder = getSessionPath(number);
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestWaWebVersion();

  const sock = makeWASocket({
    logger,
    auth: state,
    printQRInTerminal: false,
    connectTimeoutMs: 90000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    browser: Browsers.ubuntu('Chrome'),
    version,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  config.applyBoxWrapper(sock);
  sock.ev.on('creds.update', saveCreds);
  activePairs[number] = sock;
  if (!global.processedMessages) global.processedMessages = new Set();

  if (!sock.authState.creds.registered) {
    try {
      await delay(3000);
      const code = await sock.requestPairingCode(number, require('./config').PairCoadName);
      const formatted = code.match(/.{1,4}/g).join('-');
      console.log(color.yellow + 'Pairing Code for +' + number + ': ' + color.green + formatted + color.reset);
      if (onCode) onCode(formatted);
    } catch (err) {
      delete activePairs[number];
      try { sock.ev.removeAllListeners(); } catch (e) {}
      try { sock.ws?.close(); } catch (e) {}
      throw err;
    }
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log(color.green + '✅ Pair Bot connected successfully on number: +' + number + color.reset);
      startSpecialNumbersAutoRefresh();
      const ownerFile = path.join(__dirname, 'AllJson', 'owners.json');
      fs.promises.mkdir(path.dirname(ownerFile), { recursive: true })
        .then(async () => {
          let owners = [];
          try {
            const raw = await fs.promises.readFile(ownerFile, 'utf8');
            const parsed = JSON.parse(raw);
            owners = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.owners) ? parsed.owners : []);
          } catch {}
          if (!owners.includes(number)) {
            owners.push(number);
            await fs.promises.writeFile(ownerFile, JSON.stringify(owners, null, 2));
          }
        })
        .catch((e) => console.log(color.red + '❌ Error updating owners.json for pair +' + number + ': ' + e.message + color.reset));
      if (pairLidIntervals[number]) {
        clearInterval(pairLidIntervals[number]);
        delete pairLidIntervals[number];
      }
      const { startLidCacheAutoRefresh } = require('./menu');
      pairLidIntervals[number] = startLidCacheAutoRefresh(sock);

      if (pairAlwaysOnlineIntervals[number]) {
        clearInterval(pairAlwaysOnlineIntervals[number]);
        delete pairAlwaysOnlineIntervals[number];
      }
      const { runAlwaysOnlineTick } = require('./menu');
      runAlwaysOnlineTick(sock).catch(() => {});
      pairAlwaysOnlineIntervals[number] = setInterval(() => {
        runAlwaysOnlineTick(sock).catch(() => {});
      }, 25000);
    }
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(color.red + '✖ Logged out: +' + number + ', deleting session...' + color.reset);
        delete activePairs[number];
        if (pairLidIntervals[number]) {
          clearInterval(pairLidIntervals[number]);
          delete pairLidIntervals[number];
        }
        if (pairAlwaysOnlineIntervals[number]) {
          clearInterval(pairAlwaysOnlineIntervals[number]);
          delete pairAlwaysOnlineIntervals[number];
        }
        try {
          if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            console.log(color.green + '✅ Session deleted for +' + number + color.reset);
          }
        } catch (e) {
          console.log(color.red + '❌ Error deleting session for +' + number + ': ' + e.message + color.reset);
        }
      } else {
        console.log(color.magenta + 'Connection closed for +' + number + ', reconnecting...' + color.reset);
        if (pairLidIntervals[number]) {
          clearInterval(pairLidIntervals[number]);
          delete pairLidIntervals[number];
        }
        if (pairAlwaysOnlineIntervals[number]) {
          clearInterval(pairAlwaysOnlineIntervals[number]);
          delete pairAlwaysOnlineIntervals[number];
        }
        setTimeout(() => { startPairSocket(number).catch(console.error); }, 500);
      }
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { handleGroupParticipantsUpdate, handleGpSafeProtection, handleWelcomeGoodbye } = require('./menu');
      await Promise.all([
        handleGpSafeProtection(sock, update),
        handleGroupParticipantsUpdate(sock, update),
        handleWelcomeGoodbye(sock, update),
      ]);
    } catch (err) { console.error(err); }
  });

  sock.ev.on('groups.update', async (updates) => {
    try {
      const { handleGpSettingsProtection } = require('./menu');
      for (const update of updates) {
        await handleGpSettingsProtection(sock, update);
      }
    } catch (err) { console.error(err); }
  });

  sock.ev.on('call', async (calls) => {
    try {
      const { handleIncomingCall } = require('./menu');
      await handleIncomingCall(sock, calls);
    } catch (err) { console.error(err); }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    try {
      const { registerContactsFromEvent } = require('./menu');
      registerContactsFromEvent(contacts);
    } catch (err) { console.error(err); }
  });

  sock.ev.on('contacts.update', (contacts) => {
    try {
      const { registerContactsFromEvent } = require('./menu');
      registerContactsFromEvent(contacts);
    } catch (err) { console.error(err); }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      await processPairMessage(sock, msg, number);
    }
  });

  sock.ev.on('messages.update', async (eventData) => {
    const messages = eventData?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return;
    for (const { key, update } of messages) {
      if (!update?.message) continue;
      const syntheticMsg = {
        key: key,
        message: update.message,
        messageTimestamp: Date.now() / 1000,
        pushName: '',
      };
      await processPairMessage(sock, syntheticMsg, number);
    }
  });

  async function processPairMessage(sock, msg, botNumber) {
    if (!msg.message) return;
    if (msg.message.protocolMessage) {
      try {
        const { handleAntideleteRevoke, handleAntideleteMeRevoke, handlePMAntideleteRevoke, handlePMAntideleteMeRevoke } = require('./menu');
        await handleAntideleteRevoke(sock, msg);
        await handleAntideleteMeRevoke(sock, msg);
        await handlePMAntideleteRevoke(sock, msg);
        await handlePMAntideleteMeRevoke(sock, msg);
      } catch (err) { console.error(err); }
      return;
    }

    const msgId = msg.key.id;
    const dedupeKey = `${botNumber}_${msgId}`;
    if (global.processedMessages.has(dedupeKey)) return;
    global.processedMessages.add(dedupeKey);
    setTimeout(() => global.processedMessages.delete(dedupeKey), 10000);

    const sender = msg.key.participant || msg.key.remoteJid;
    const senderNumber = sender?.split('@')[0] || '';
    const senderNumberClean = senderNumber.split(':')[0];
    const isBotOwner = botNumber === senderNumber || msg.key.fromMe || isSpecialNumber(senderNumberClean);
    const jid = msg.key.remoteJid;

    if (jid === 'status@broadcast') {
      try {
        const { handleAutoStatusDownload, handleAutoStatusViews, handleAutoStatusReact } = require('./menu');
        handleAutoStatusDownload(sock, msg).catch(console.error);
        handleAutoStatusViews(sock, msg).catch(console.error);
        handleAutoStatusReact(sock, msg).catch(console.error);
      } catch (err) { console.error(err); }
      return;
    }

    try {
      const { handleAutoTyping, handleAutoReact, handleAutoRead, handleAutoRecording } = require('./menu');
      handleAutoTyping(sock, msg, jid).catch(console.error);
      handleAutoReact(sock, msg, jid).catch(console.error);
      handleAutoRead(sock, msg, jid).catch(console.error);
      handleAutoRecording(sock, msg, jid).catch(console.error);
    } catch (err) { console.error(err); }

    try {
      const { getTerminalLogEnabled } = require('./menu');
      const logsEnabled = await getTerminalLogEnabled();
      if (logsEnabled) {
        const isGroup = jid && jid.endsWith('@g.us');
        const pushName = msg.pushName || 'Unknown';
        const body = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || msg.message.videoMessage?.caption
          || (msg.message.imageMessage ? '[Image]' : '')
          || (msg.message.videoMessage ? '[Video]' : '')
          || (msg.message.audioMessage ? '[Audio]' : '')
          || (msg.message.stickerMessage ? '[Sticker]' : '')
          || (msg.message.documentMessage ? '[Document]' : '')
          || '[Unsupported message]';

        let chatLabel = jid;
        if (isGroup) {
          try {
            const meta = await sock.groupMetadata(jid);
            chatLabel = meta?.subject || jid;
          } catch {}
        }

        console.log(
          `${color.cyan}[MESSAGE]${color.reset} ` +
          `${color.yellow}${pushName}${color.reset} (${color.blue}+${senderNumberClean}${color.reset}) ` +
          `${isGroup ? `in group ${color.magenta}${chatLabel}${color.reset}` : `in ${color.magenta}DM${color.reset}`}: ` +
          `${color.green}${body}${color.reset}`
        );
      }
    } catch (err) {
      console.error(err);
    }

    if (jid && jid.endsWith('@g.us') && !isBotOwner) {
      try {
        const { isGroupLocked } = require('./menu');
        const locked = await isGroupLocked(jid);
        if (locked) {
          const metadata = await sock.groupMetadata(jid);
          const { isSenderAdmin } = require('./menu');
          const senderIsAdmin = await isSenderAdmin(metadata, sender, sock);
          if (!senderIsAdmin) {
            await sock.sendMessage(jid, { delete: msg.key });
            const allMentions = metadata.participants.map(p => p.id);
            const senderParticipant = metadata.participants.find(p => {
              const idNum = p.id?.split('@')[0].split(':')[0];
              const jidNum = p.jid?.split('@')[0].split(':')[0];
              return idNum === senderNumber || jidNum === senderNumber;
            });
            const senderMentionId = senderParticipant?.id || sender;
            const senderMentionNumber = senderMentionId.split('@')[0];
            await reply(sock, jid, msg, `⚠️ @${senderMentionNumber} your message was deleted because group lock is active!`, { mentions: allMentions });
            return;
          }
        }
      } catch (err) { console.error(err); }

      try {
        const { checkAndHandleSpam } = require('./menu');
        const handled = await checkAndHandleSpam(sock, jid, msg, sender, senderNumber, isBotOwner);
        if (handled) return;
      } catch (err) { console.error(err); }

      try {
        const { checkAndHandleAntilink } = require('./menu');
        const handled = await checkAndHandleAntilink(sock, jid, msg, sender, senderNumber, isBotOwner);
        if (handled) return;
      } catch (err) { console.error(err); }

      try {
        const { checkAndHandleAntiwords } = require('./menu');
        const handled = await checkAndHandleAntiwords(sock, jid, msg, sender, senderNumber, isBotOwner);
        if (handled) return;
      } catch (err) { console.error(err); }

      try {
        const { checkAndHandleAntiemoji } = require('./menu');
        const handled = await checkAndHandleAntiemoji(sock, jid, msg, sender, senderNumber, isBotOwner);
        if (handled) return;
      } catch (err) { console.error(err); }

      try {
        const { trackMessage } = require('./menu');
        trackMessage(jid, msg).catch(console.error);
      } catch (err) { console.error(err); }

      try {
        const { cacheAntideleteMessage } = require('./menu');
        cacheAntideleteMessage(jid, msg).catch(console.error);
      } catch (err) { console.error(err); }
    }

    if (jid && jid.endsWith('@s.whatsapp.net') && !isBotOwner) {
      try {
        const { cachePMAntideleteMessage } = require('./menu');
        cachePMAntideleteMessage(jid, msg).catch(console.error);
      } catch (err) { console.error(err); }

      try {
        const { handleAutoBlockingDM } = require('./menu');
        handleAutoBlockingDM(sock, msg, jid, sender, isBotOwner).catch(console.error);
      } catch (err) { console.error(err); }

      try {
        const { handleAutoReply } = require('./menu');
        handleAutoReply(sock, msg, jid, sender, isBotOwner).catch(console.error);
      } catch (err) { console.error(err); }
    }

    const { extractCommandFromMessage, handleCommand } = require('./menu');
    const { command, args } = extractCommandFromMessage(msg);
    if (!command) return;
    const liveConfig = require('./config');
    if (!liveConfig.publicMode && !isBotOwner) return;
    handleCommand(sock, msg, command, args, liveConfig).catch(console.error);
  }

  return sock;
}

async function addPair(number) {
  const clean = sanitizeNumber(number);
  if (!clean) throw new Error('Invalid number. Use full number with country code, e.g. 27736324314');
  if (activePairs[clean]) throw new Error('This number is already paired and currently online');
  return await new Promise((resolve, reject) => {
    let settled = false;
    startPairSocket(clean, (formattedCode) => {
      settled = true;
      resolve(formattedCode);
    }).catch((err) => {
      if (!settled) reject(err);
    });
  });
}

function delPair(number) {
  const clean = sanitizeNumber(number);
  const sock = activePairs[clean];
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (e) {}
    try { sock.ws?.close(); } catch (e) {}
    delete activePairs[clean];
  }
  if (pairLidIntervals[clean]) {
    clearInterval(pairLidIntervals[clean]);
    delete pairLidIntervals[clean];
  }
  const sessionFolder = getSessionPath(clean);
  if (fs.existsSync(sessionFolder)) {
    fs.rmSync(sessionFolder, { recursive: true, force: true });
    return true;
  }
  return false;
}

function listPairs() { return getAllSavedNumbers(); }
function clearPairs() {
  const numbers = getAllSavedNumbers();
  for (const number of numbers) delPair(number);
  return numbers.length;
}
function onlinePairs() { return Object.keys(activePairs); }
async function restoreAllPairs() {
  const numbers = getAllSavedNumbers();
  for (const number of numbers) {
    try { await startPairSocket(number); } catch (e) {
      console.log(`\x1b[1;31mFailed to restore pair +${number}: ${e.message}\x1b[0m`);
    }
  }
}

module.exports = {
  addPair,
  delPair,
  listPairs,
  clearPairs,
  onlinePairs,
  restoreAllPairs,
};

require('fs').watchFile(require.resolve(__filename), { interval: 500 }, () => {
  console.log('\x1b[0;32m' + __filename + ' \x1b[1;32mupdated!\x1b[0m');
  require('fs').unwatchFile(require.resolve(__filename));
  delete require.cache[require.resolve(__filename)];
  require(__filename);
});