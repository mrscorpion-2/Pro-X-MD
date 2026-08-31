// BEFORE (your current code breaks on Render):
// const number = await question("Enter your number:")

// AFTER - FIX FOR RENDER:
const usePairingCode = true; // or false if you use QR
let phoneNumber = process.env.PHONE_NUMBER || "27736324314";

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session')
    
    // Fix 1: Don't use readline on Render
    if (!phoneNumber && process.stdin.isTTY) {
        // Only ask if running on your own PC
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        phoneNumber = await new Promise((resolve) => {
            rl.question("Enter your WhatsApp number with country code: '+27736324314', (ans) => {
                rl.close()
                resolve(ans)
            })
        })
    }

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: !usePairingCode
    })

    if (usePairingCode && !sock.authState.creds.registered) {
        if (!phoneNumber) {
            console.log("Add PHONE_NUMBER in Render Environment Variables!")
            phoneNumber = process.env.PHONE_NUMBER
        }
        const code = await sock.requestPairingCode(phoneNumber.trim())
        console.log(`Pairing Code: ${code}`)
    }
    }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const color = {
  reset: '\x1b[0m',
  green: '\x1b[1;32m',
  cyan: '\x1b[1;36m',
  yellow: '\x1b[1;33m',
  red: '\x1b[1;31m',
  magenta: '\x1b[1;35m',
  blue: '\x1b[1;34m',
};

if (!global.__consoleErrorPatched) {
  global.__consoleErrorPatched = true;
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    originalConsoleError(...args);
    try {
      const msg = args.map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      reportError('console.error', msg).catch(() => {});
    } catch (e) {}
  };
}
if (!global.__mainProcessHandlersRegistered) {
  global.__mainProcessHandlersRegistered = true;
  process.on('uncaughtException', (err) => {
    console.log('\x1b[1;31m[uncaughtException] ' + (err?.stack || err) + '\x1b[0m');
    reportError('uncaughtException (bot may have crashed)', err).catch(() => {});
  });
  process.on('unhandledRejection', (err) => {
    console.log('\x1b[1;31m[unhandledRejection] ' + (err?.stack || err) + '\x1b[0m');
    reportError('unhandledRejection', err).catch(() => {});
  });
}

async function startBot() {
  if (global.conn) {
    try { global.conn.ev.removeAllListeners(); } catch (e) {}
    try { global.conn.ws?.close(); } catch (e) {}
  }
  if (global.lidCacheInterval) {
    clearInterval(global.lidCacheInterval);
    global.lidCacheInterval = null;
  }
  if (!fs.existsSync(SESSION_FOLDER)) {
    fs.mkdirSync(SESSION_FOLDER, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
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
  global.processedMessages = new Set();
  sock.ev.on('creds.update', saveCreds);
  global.conn = sock;

  if (!sock.authState.creds.registered) {
    const rawNumber = await question(color.cyan + 'Enter your WhatsApp number (example: 27xxx): ' + color.reset);
    const cleanNumber = rawNumber.replace(/[^0-9]/g, '');
    try {
      const code = await sock.requestPairingCode(cleanNumber, config.PairCoadName);
      const formattedCode = code.match(/.{1,4}/g).join('-');
      console.log(color.yellow + 'Your Pairing Code: ' + color.green + formattedCode + color.reset);
      console.log(color.cyan + 'WhatsApp → Linked Devices → Link a Device → Enter Code' + color.reset);
    } catch (err) {
      console.log(color.red + 'Failed to request pairing code: ' + err.message + color.reset);
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      const num = sock.user.id.split(':')[0].split('@')[0];
      console.log(color.green + '✔ Bot connected successfully on number: +' + num + color.reset);
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
          if (!owners.includes(num)) {
            owners.push(num);
            await fs.promises.writeFile(ownerFile, JSON.stringify(owners, null, 2));
          }
        })
        .catch((e) => console.log(color.red + '❌ Error updating owners.json: ' + e.message + color.reset));

      if (!global.pairsRestored) {
        global.pairsRestored = true;
        require('./pairbot').restoreAllPairs().catch(console.error);
      }
      if (!global.lidCacheInterval) {
        const { startLidCacheAutoRefresh } = require('./menu');
        global.lidCacheInterval = startLidCacheAutoRefresh(sock);
      }
      if (global.alwaysOnlineInterval) {
        clearInterval(global.alwaysOnlineInterval);
        global.alwaysOnlineInterval = null;
      }
      const { runAlwaysOnlineTick } = require('./menu');
      runAlwaysOnlineTick(sock).catch(() => {});
      global.alwaysOnlineInterval = setInterval(() => {
        runAlwaysOnlineTick(sock).catch(() => {});
      }, 25000);
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(color.red + '✖ Logged out, deleting session...' + color.reset);
        try {
          if (fs.existsSync(SESSION_FOLDER)) {
            fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
            console.log(color.green + '✅ Session deleted successfully' + color.reset);
          }
          fs.mkdirSync(SESSION_FOLDER, { recursive: true });
        } catch (e) {
          console.log(color.red + '❌ Error deleting session: ' + e.message + color.reset);
        }
        setTimeout(() => startBot(), 2000);
      } else {
        console.log(color.magenta + 'Connection closed, reconnecting...' + color.reset);
        setTimeout(() => startBot(), 500);
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
    } catch (err) {
      console.error(err);
    }
  });

  sock.ev.on('groups.update', async (updates) => {
    try {
      const { handleGpSettingsProtection } = require('./menu');
      for (const update of updates) {
        await handleGpSettingsProtection(sock, update);
      }
    } catch (err) {
      console.error(err);
    }
  });

  sock.ev.on('call', async (calls) => {
    try {
      const { handleIncomingCall } = require('./menu');
      await handleIncomingCall(sock, calls);
    } catch (err) {
      console.error(err);
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    try {
      const { registerContactsFromEvent } = require('./menu');
      registerContactsFromEvent(contacts);
    } catch (err) {
      console.error(err);
    }
  });

  sock.ev.on('contacts.update', (contacts) => {
    try {
      const { registerContactsFromEvent } = require('./menu');
      registerContactsFromEvent(contacts);
    } catch (err) {
      console.error(err);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      await processMessage(sock, msg);
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
      await processMessage(sock, syntheticMsg);
    }
  });

  async function processMessage(sock, msg) {
    if (!msg.message) return;
    if (msg.message.protocolMessage) {
      try {
        const { handleAntideleteRevoke, handleAntideleteMeRevoke, handlePMAntideleteRevoke, handlePMAntideleteMeRevoke } = require('./menu');
        await handleAntideleteRevoke(sock, msg);
        await handleAntideleteMeRevoke(sock, msg);
        await handlePMAntideleteRevoke(sock, msg);
        await handlePMAntideleteMeRevoke(sock, msg);
      } catch (err) {
        console.error(err);
      }
      return;
    }

    const msgId = msg.key.id;
    const botNumber = sock.user.id.split(':')[0];
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
}

startBot().catch(console.error);

require('fs').watchFile(require.resolve(__filename), { interval: 500 }, () => {
  console.log('\x1b[0;32m' + __filename + ' \x1b[1;32mupdated!\x1b[0m');
  require('fs').unwatchFile(require.resolve(__filename));
  delete require.cache[require.resolve(__filename)];
  require(__filename);
});
