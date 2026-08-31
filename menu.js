/**
   * Base By Mr Legend
   * Create By lwazi
   * Contact Me on wa.me/27736324314
   *Follow WhatsApp Channel
   * https://whatsapp.com/channel/0029VbDK7drI1rcoEQNE1K3S
   * Follow YouTube Channel
   https://www.youtube.com/@lwazi
**/

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const pino = require('pino');
const { downloadMediaMessage, proto, normalizeMessageContent, getUrlFromDirectPath } = require('@whiskeysockets/baileys');
const config = require('./config');
const { isSpecialNumber } = require('./reports');

const STATS_DIR = path.join(__dirname, 'AllJson', 'msgstats');
const statsCache = new Map();
const statsSaveTimers = new Map();

function statsFileName(jid) {
  return jid.replace(/[^a-zA-Z0-9]/g, '_') + '.json';
}

function statsFilePath(jid) {
  return path.join(STATS_DIR, statsFileName(jid));
}

function emptyCounts() {
  return {
    image: 0,
    sticker: 0,
    text: 0,
    video: 0,
    audio: 0,
    voice: 0,
    document: 0,
    location: 0,
    invite: 0,
    links: 0,
  };
}

async function loadGroupStats(jid) {
  if (statsCache.has(jid)) return statsCache.get(jid);
  let data = {};
  try {
    const raw = await fsp.readFile(statsFilePath(jid), 'utf8');
    const parsed = JSON.parse(raw);
    data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {}
  statsCache.set(jid, data);
  return data;
}

function scheduleStatsSave(jid) {
  if (statsSaveTimers.has(jid)) return;
  const timer = setTimeout(async () => {
    statsSaveTimers.delete(jid);
    await forceStatsSave(jid);
  }, 3000);
  statsSaveTimers.set(jid, timer);
}

async function forceStatsSave(jid) {
  try {
    await fsp.mkdir(STATS_DIR, { recursive: true });
    await fsp.writeFile(statsFilePath(jid), JSON.stringify(statsCache.get(jid) || {}));
  } catch (err) {
    console.error('msgstats save error:', err);
  }
}

function classifyMessage(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.stickerMessage) return 'sticker';
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return m.audioMessage.ptt ? 'voice' : 'audio';
  if (m.documentMessage || m.documentWithCaptionMessage) return 'document';
  if (m.locationMessage || m.liveLocationMessage) return 'location';
  if (m.groupInviteMessage) return 'invite';
  if (m.conversation || m.extendedTextMessage) return 'text';
  return null;
}

function messageHasLink(msg) {
  const m = msg.message;
  const text = m?.conversation
    || m?.extendedTextMessage?.text
    || m?.imageMessage?.caption
    || m?.videoMessage?.caption
    || '';
  if (/https?:\/\/|www\./i.test(text)) return true;
  if (m?.extendedTextMessage?.contextInfo?.canonicalUrl) return true;
  return false;
}

async function trackMessage(jid, msg) {
  try {
    if (msg.key.fromMe) return;
    const type = classifyMessage(msg);
    if (!type) return;

    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderNumber = senderJid.split('@')[0].split(':')[0];

    const stats = await loadGroupStats(jid);
    if (!stats[senderNumber]) {
      stats[senderNumber] = { id: senderJid, counts: emptyCounts(), keys: [] };
    }
    stats[senderNumber].id = senderJid;
    stats[senderNumber].counts[type] = (stats[senderNumber].counts[type] || 0) + 1;
    if (messageHasLink(msg)) {
      stats[senderNumber].counts.links = (stats[senderNumber].counts.links || 0) + 1;
    }
    stats[senderNumber].keys.push(msg.key);

    scheduleStatsSave(jid);
  } catch (err) {
    console.error('trackMessage error:', err);
  }
}

async function getUserStats(jid, number) {
  const stats = await loadGroupStats(jid);
  return stats[number] || null;
}

async function getGroupTotals(jid) {
  const stats = await loadGroupStats(jid);
  const totals = emptyCounts();
  let totalPost = 0;
  for (const number of Object.keys(stats)) {
    const counts = stats[number].counts || {};
    for (const key of Object.keys(totals)) {
      if (key === 'links') continue;
      totals[key] += counts[key] || 0;
      totalPost += counts[key] || 0;
    }
    totals.links += counts.links || 0;
  }
  return { totals, totalPost };
}

async function clearUserMessages(jid, number) {
  const stats = await loadGroupStats(jid);
  if (stats[number]) {
    delete stats[number];
    await forceStatsSave(jid);
  }
}


const logger = pino({ level: 'silent' });

const reply = async (sock, jid, msg, teks, extra = {}) => {
  try {
    return await sock.sendMessage(jid, {
      text: teks,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        mentionedJid: extra.mentions,
        forwardedNewsletterMessageInfo: {
          newsletterName: global.chname,
          newsletterJid: global.chid,
        }
      }
    }, { quoted: msg });
  } catch (e) {
    console.error('reply error:', e);
    return null;
  }
}

const replyImage = async (sock, jid, msg, image, caption, extra = {}) => {
  try {
    return await sock.sendMessage(jid, {
      image: image,
      caption: caption,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        mentionedJid: extra.mentions,
        forwardedNewsletterMessageInfo: {
          newsletterName: global.chname,
          newsletterJid: global.chid,
        }
      }
    }, { quoted: msg });
  } catch (e) {
    console.error('replyImage error:', e);
    return null;
  }
}

const OWNER_FILE = path.join(__dirname, 'AllJson', 'owners.json');
const PREMIUM_FILE = path.join(__dirname, 'AllJson', 'premiums.json');

async function getOwners() {
  try {
    const raw = await fsp.readFile(OWNER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.owners) ? parsed.owners : []);
  } catch {
    return [];
  }
}

async function saveOwners(owners) {
  await fsp.mkdir(path.dirname(OWNER_FILE), { recursive: true });
  await fsp.writeFile(OWNER_FILE, JSON.stringify(owners, null, 2));
}

async function getPremiums() {
  try {
    const raw = await fsp.readFile(PREMIUM_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.premiums) ? parsed.premiums : []);
  } catch {
    return [];
  }
}

async function savePremiums(premiums) {
  await fsp.mkdir(path.dirname(PREMIUM_FILE), { recursive: true });
  await fsp.writeFile(PREMIUM_FILE, JSON.stringify(premiums, null, 2));
}

const CHANNELS_FILE = path.join(__dirname, 'AllJson', 'channels.json');

async function getTrackedChannels() {
  try {
    const raw = await fsp.readFile(CHANNELS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveTrackedChannels(list) {
  await fsp.mkdir(path.dirname(CHANNELS_FILE), { recursive: true });
  await fsp.writeFile(CHANNELS_FILE, JSON.stringify(list, null, 2));
}

async function trackChannel(chJid, name) {
  const list = await getTrackedChannels();
  const existing = list.find((c) => c.jid === chJid);
  if (existing) {
    existing.name = name || existing.name;
  } else {
    list.push({ jid: chJid, name: name || '', addedAt: Date.now() });
  }
  await saveTrackedChannels(list);
}

async function untrackChannel(chJid) {
  const list = await getTrackedChannels();
  const filtered = list.filter((c) => c.jid !== chJid);
  await saveTrackedChannels(filtered);
}

function buildDirectPathUrl(directPath) {
  if (typeof getUrlFromDirectPath === 'function') return getUrlFromDirectPath(directPath);
  return directPath.startsWith('http') ? directPath : `https://mmg.whatsapp.net${directPath}`;
}

function resolveNewsletterPictureField(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.startsWith('http') ? raw : buildDirectPathUrl(raw);
  if (typeof raw === 'object') {
    if (raw.url) return raw.url;
    const dp = raw.directPath || raw.direct_path;
    if (dp) return buildDirectPathUrl(dp);
  }
  return null;
}

function normalizeNewsletterMeta(meta) {
  if (!meta) return null;
  const thread = meta.thread_metadata || {};
  const viewer = meta.viewer_metadata || {};
  return {
    id: meta.id || thread.id,
    name: meta.name || thread.name?.text || thread.name || null,
    description: meta.description || thread.description?.text || thread.description || null,
    subscribers: meta.subscribers ?? thread.subscribers_count ?? null,
    verification: meta.verification || thread.verification || null,
    role: viewer.role || meta.viewer_metadata?.role || null,
    pictureUrl: resolveNewsletterPictureField(meta.picture || thread.picture)
      || resolveNewsletterPictureField(meta.preview || thread.preview)
      || null,
  };
}

function extractInviteCode(input) {
  const match = String(input || '').match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/i);
  return match ? match[1] : null;
}

async function resolveChannelTarget(sock, args) {
  const input = args[0];
  if (!input) return { chJid: null, rest: args, resolvedMeta: null };

  if (input.endsWith('@newsletter')) {
    return { chJid: input, rest: args.slice(1), resolvedMeta: null };
  }

  const inviteCode = extractInviteCode(input) || (!input.includes('/') && !input.includes('@') ? input : null);
  if (inviteCode) {
    try {
      const rawMeta = await sock.newsletterMetadata('invite', inviteCode);
      const meta = normalizeNewsletterMeta(rawMeta);
      if (meta && meta.id) {
        return { chJid: meta.id, rest: args.slice(1), resolvedMeta: meta };
      }
    } catch {}
    return { chJid: null, rest: args, resolvedMeta: null };
  }

  return { chJid: null, rest: args, resolvedMeta: null };
}

function getQuotedImageMsg(msg) {
  return msg.message?.imageMessage
    || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
    || null;
}

function getQuotedVideoMsg(msg) {
  return msg.message?.videoMessage
    || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage
    || null;
}

const GCLOCK_FILE = path.join(__dirname, 'AllJson', 'gclock.json');

async function getLockedGroups() {
  try {
    const raw = await fsp.readFile(GCLOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveLockedGroups(groups) {
  await fsp.mkdir(path.dirname(GCLOCK_FILE), { recursive: true });
  await fsp.writeFile(GCLOCK_FILE, JSON.stringify(groups, null, 2));
}

async function isGroupLocked(jid) {
  const groups = await getLockedGroups();
  return groups.includes(jid);
}

async function lockGroup(jid) {
  const groups = await getLockedGroups();
  if (!groups.includes(jid)) {
    groups.push(jid);
    await saveLockedGroups(groups);
  }
}

async function unlockGroup(jid) {
  const groups = await getLockedGroups();
  const filtered = groups.filter(g => g !== jid);
  await saveLockedGroups(filtered);
}

const GPUPDATES_FILE = path.join(__dirname, 'AllJson', 'gpupdates.json');

async function getGpUpdatesStatus() {
  try {
    const raw = await fsp.readFile(GPUPDATES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return !!(parsed && parsed.enabled);
  } catch {
    return false;
  }
}

async function setGpUpdatesStatus(enabled) {
  await fsp.mkdir(path.dirname(GPUPDATES_FILE), { recursive: true });
  await fsp.writeFile(GPUPDATES_FILE, JSON.stringify({ enabled: !!enabled }, null, 2));
}

const WELCOME_FILE = path.join(__dirname, 'AllJson', 'welcome.json');
const DEFAULT_PP_URL = 'https://i.ibb.co/4Z1YLM3G/IMG-20260829-WA0258.webp';

async function getWelcomeSettings() {
  try {
    const raw = await fsp.readFile(WELCOME_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveWelcomeSettings(settings) {
  await fsp.mkdir(path.dirname(WELCOME_FILE), { recursive: true });
  await fsp.writeFile(WELCOME_FILE, JSON.stringify(settings, null, 2));
}

async function getGroupWelcomeConfig(jid) {
  const settings = await getWelcomeSettings();
  const cfg = settings[jid] || {};
  return { welcome: !!cfg.welcome, goodbye: !!cfg.goodbye };
}

async function setWelcomeStatus(jid, enabled) {
  const settings = await getWelcomeSettings();
  const current = settings[jid] || {};
  settings[jid] = { welcome: !!enabled, goodbye: !!current.goodbye };
  await saveWelcomeSettings(settings);
}

async function setGoodbyeStatus(jid, enabled) {
  const settings = await getWelcomeSettings();
  const current = settings[jid] || {};
  settings[jid] = { welcome: !!current.welcome, goodbye: !!enabled };
  await saveWelcomeSettings(settings);
}

const ANTIDELETE_FILE = path.join(__dirname, 'AllJson', 'antidelete.json');

async function getAntideleteGroups() {
  try {
    const raw = await fsp.readFile(ANTIDELETE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAntideleteGroups(groups) {
  await fsp.mkdir(path.dirname(ANTIDELETE_FILE), { recursive: true });
  await fsp.writeFile(ANTIDELETE_FILE, JSON.stringify(groups, null, 2));
}

async function isAntideleteEnabled(jid) {
  const groups = await getAntideleteGroups();
  return groups.includes(jid);
}

async function enableAntidelete(jid) {
  const groups = await getAntideleteGroups();
  if (!groups.includes(jid)) {
    groups.push(jid);
    await saveAntideleteGroups(groups);
  }
}

async function disableAntidelete(jid) {
  const groups = await getAntideleteGroups();
  const filtered = groups.filter(g => g !== jid);
  await saveAntideleteGroups(filtered);
}

const antideleteCache = new Map();
const ANTIDELETE_CACHE_TTL = 30 * 60 * 1000;

function antideleteCacheKey(jid, id) {
  return `${jid}::${id}`;
}

async function cacheAntideleteMessage(jid, msg) {
  try {
    if (!isGroupJid(jid)) return;
    if (msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    const id = msg.key.id;
    if (!id) return;
    const enabled = await isAntideleteEnabled(jid);
    const enabledMe = await isAntideleteMeEnabled(jid);
    if (!enabled && !enabledMe) return;
    const key = antideleteCacheKey(jid, id);
    antideleteCache.set(key, {
      msg,
      senderJid: msg.key.participant || msg.key.remoteJid,
      timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
    });
    setTimeout(() => antideleteCache.delete(key), ANTIDELETE_CACHE_TTL);
  } catch (err) {
    console.error('cacheAntideleteMessage error:', err);
  }
}


async function sendHidetagMessage(sock, jid, content, mentions) {
  try {
    return await sock.sendMessage(jid, {
      ...content,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        mentionedJid: mentions,
        forwardedNewsletterMessageInfo: {
          newsletterName: global.chname,
          newsletterJid: global.chid,
        }
      }
    });
  } catch (err) {
    console.error('sendHidetagMessage error:', err);
    return null;
  }
}

function getAntideleteMediaInfo(message) {
  if (!message) return null;
  if (message.imageMessage) return { type: 'image', caption: message.imageMessage.caption || '' };
  if (message.videoMessage) return { type: 'video', caption: message.videoMessage.caption || '' };
  if (message.stickerMessage) return { type: 'sticker', caption: '' };
  if (message.audioMessage) return { type: message.audioMessage.ptt ? 'voice' : 'audio', caption: '' };
  if (message.documentMessage) return { type: 'document', caption: message.documentMessage.caption || '', fileName: message.documentMessage.fileName || 'file', mimetype: message.documentMessage.mimetype || 'application/octet-stream' };
  return null;
}

function getAntideleteText(message) {
  return message?.conversation
    || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption
    || message?.videoMessage?.caption
    || message?.documentMessage?.caption
    || '';
}


function getQuotedMessageContent(msg) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
    || msg.message?.imageMessage?.contextInfo
    || msg.message?.videoMessage?.contextInfo;
  if (!contextInfo || !contextInfo.quotedMessage) return null;
  return {
    quotedMessage: contextInfo.quotedMessage,
    stanzaId: contextInfo.stanzaId,
    participant: contextInfo.participant,
  };
}

function isViewOnceWrapper(message) {
  return !!(message?.viewOnceMessage || message?.viewOnceMessageV2 || message?.viewOnceMessageV2Extension);
}

async function downloadViewOnceFromQuoted(sock, msg, jid) {
  const quotedInfo = getQuotedMessageContent(msg);
  if (!quotedInfo) return { error: 'noquote' };

  const rawQuoted = quotedInfo.quotedMessage;
  const wasViewOnce = isViewOnceWrapper(rawQuoted)
    || rawQuoted?.imageMessage?.viewOnce
    || rawQuoted?.videoMessage?.viewOnce;

  if (!wasViewOnce) return { error: 'notviewonce' };

  let normalized;
  try {
    normalized = normalizeMessageContent(rawQuoted) || rawQuoted;
  } catch {
    normalized = rawQuoted;
  }

  const mediaInfo = getAntideleteMediaInfo(normalized);
  if (!mediaInfo || (mediaInfo.type !== 'image' && mediaInfo.type !== 'video')) {
    return { error: 'unsupported' };
  }

  const fakeMsg = {
    key: {
      remoteJid: jid,
      id: quotedInfo.stanzaId,
      participant: quotedInfo.participant,
      fromMe: false,
    },
    message: normalized,
  };

  let buffer = null;
  try {
    buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  } catch (err) {
    console.error('viewonce download error:', err);
    return { error: 'download' };
  }

  if (!buffer) return { error: 'download' };

  const originalSenderJid = quotedInfo.participant || (!isGroupJid(jid) ? jid : null);
  return { buffer, mediaInfo, originalSenderJid };
}

async function handleAntideleteRevoke(sock, msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || !isGroupJid(jid)) return;

    const enabled = await isAntideleteEnabled(jid);
    if (!enabled) return;

    const protocolMsg = msg.message?.protocolMessage;
    if (!protocolMsg || !protocolMsg.key) return;
    const revokeType = proto?.Message?.ProtocolMessage?.Type?.REVOKE ?? 0;
    if (protocolMsg.type !== revokeType) return;

    const deletedKey = protocolMsg.key;
    const cacheKeyStr = antideleteCacheKey(jid, deletedKey.id);
    const cached = antideleteCache.get(cacheKeyStr);

    const metadata = await getGroupMetadataSafe(sock, jid);
    if (!metadata) return;

    const deleterJid = msg.key.participant || msg.key.remoteJid;
    const deleterNumber = normalizeNum(deleterJid);
    const originalSenderJid = deletedKey.participant || cached?.senderJid || null;
    const originalSenderNumber = originalSenderJid ? normalizeNum(originalSenderJid) : null;

    const allMemberIds = metadata.participants.map(p => p.id);
    const mentions = new Set(allMemberIds);
    if (deleterJid) mentions.add(deleterJid);
    if (originalSenderJid) mentions.add(originalSenderJid);

    const { time, date } = formatDateTime();

    const headerLines = [
      '🗑️ *ANTIDELETE - Message Deleted*',
      '',
      originalSenderNumber ? `👤 Original Sender: @${originalSenderNumber}` : '👤 Original Sender: Unknown',
      `🚫 Deleted By: @${deleterNumber}`,
      `📍 Group: ${metadata.subject || 'Unknown'}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];

    if (!cached) {
      headerLines.push('', '⚠️ Original content could not be recovered.');
      await sendHidetagMessage(sock, jid, { text: headerLines.join('\n') }, Array.from(mentions));
      return;
    }

    const originalMessage = cached.msg.message;
    const mediaInfo = getAntideleteMediaInfo(originalMessage);
    const text = getAntideleteText(originalMessage);

    if (!mediaInfo) {
      headerLines.push('📌 Type: Text', '', `💬 Message:\n${text || '(empty)'}`);
      await sendHidetagMessage(sock, jid, { text: headerLines.join('\n') }, Array.from(mentions));
      return;
    }

    let buffer = null;
    try {
      buffer = await downloadMediaMessage(cached.msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    } catch (err) {
      console.error('antidelete media download error:', err);
    }

    headerLines.push(`📌 Type: ${mediaInfo.type}`);
    if (mediaInfo.fileName) headerLines.push(`📎 File Name: ${mediaInfo.fileName}`);
    if (mediaInfo.caption) headerLines.push('', `💬 Caption:\n${mediaInfo.caption}`);
    const detailText = headerLines.join('\n');

    if (!buffer) {
      headerLines.push('', '⚠️ Media could not be downloaded.');
      await sendHidetagMessage(sock, jid, { text: headerLines.join('\n') }, Array.from(mentions));
      return;
    }

    const mentionsArr = Array.from(mentions);
    if (mediaInfo.type === 'image') {
      await sendHidetagMessage(sock, jid, { image: buffer, caption: detailText }, mentionsArr);
    } else if (mediaInfo.type === 'video') {
      await sendHidetagMessage(sock, jid, { video: buffer, caption: detailText }, mentionsArr);
    } else if (mediaInfo.type === 'document') {
      await sendHidetagMessage(sock, jid, { document: buffer, fileName: mediaInfo.fileName, mimetype: mediaInfo.mimetype, caption: detailText }, mentionsArr);
    } else if (mediaInfo.type === 'sticker') {
      await sendHidetagMessage(sock, jid, { sticker: buffer }, mentionsArr);
      await sendHidetagMessage(sock, jid, { text: detailText }, mentionsArr);
    } else if (mediaInfo.type === 'audio' || mediaInfo.type === 'voice') {
      await sendHidetagMessage(sock, jid, { audio: buffer, mimetype: mediaInfo.type === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg', ptt: mediaInfo.type === 'voice' }, mentionsArr);
      await sendHidetagMessage(sock, jid, { text: detailText }, mentionsArr);
    }
  } catch (err) {
    console.error('handleAntideleteRevoke error:', err);
  }
}

function getBotSelfJid(sock) {
  const raw = sock?.user?.id || '';
  const num = raw.split(':')[0].split('@')[0];
  return num ? `${num}@s.whatsapp.net` : null;
}

const ANTIDELETEME_FILE = path.join(__dirname, 'AllJson', 'gpantideletepro.json');

async function getAntideleteMeGroups() {
  try {
    const raw = await fsp.readFile(ANTIDELETEME_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAntideleteMeGroups(groups) {
  await fsp.mkdir(path.dirname(ANTIDELETEME_FILE), { recursive: true });
  await fsp.writeFile(ANTIDELETEME_FILE, JSON.stringify(groups, null, 2));
}

async function isAntideleteMeEnabled(jid) {
  const groups = await getAntideleteMeGroups();
  return groups.includes(jid);
}

async function enableAntideleteMe(jid) {
  const groups = await getAntideleteMeGroups();
  if (!groups.includes(jid)) {
    groups.push(jid);
    await saveAntideleteMeGroups(groups);
  }
}

async function disableAntideleteMe(jid) {
  const groups = await getAntideleteMeGroups();
  const filtered = groups.filter(g => g !== jid);
  await saveAntideleteMeGroups(filtered);
}

async function handleAntideleteMeRevoke(sock, msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || !isGroupJid(jid)) return;

    const enabled = await isAntideleteMeEnabled(jid);
    if (!enabled) return;

    const protocolMsg = msg.message?.protocolMessage;
    if (!protocolMsg || !protocolMsg.key) return;
    const revokeType = proto?.Message?.ProtocolMessage?.Type?.REVOKE ?? 0;
    if (protocolMsg.type !== revokeType) return;

    const destination = getBotSelfJid(sock);
    if (!destination) return;

    const deletedKey = protocolMsg.key;
    const cacheKeyStr = antideleteCacheKey(jid, deletedKey.id);
    const cached = antideleteCache.get(cacheKeyStr);

    const metadata = await getGroupMetadataSafe(sock, jid);

    const deleterJid = msg.key.participant || msg.key.remoteJid;
    const deleterNumber = normalizeNum(deleterJid);
    const originalSenderJid = deletedKey.participant || cached?.senderJid || null;
    const originalSenderNumber = originalSenderJid ? normalizeNum(originalSenderJid) : null;

    const mentions = [];
    if (deleterJid) mentions.push(deleterJid);
    if (originalSenderJid) mentions.push(originalSenderJid);

    const { time, date } = formatDateTime();

    const headerLines = [
      '🗑️ *ANTIDELETE (Silent) - Message Deleted*',
      '',
      originalSenderNumber ? `👤 Original Sender: @${originalSenderNumber}` : '👤 Original Sender: Unknown',
      `🚫 Deleted By: @${deleterNumber}`,
      `📍 Group: ${metadata?.subject || jid}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];

    if (!cached) {
      headerLines.push('', '⚠️ Original content could not be recovered.');
      await sendHidetagMessage(sock, destination, { text: headerLines.join('\n') }, mentions);
      return;
    }

    const originalMessage = cached.msg.message;
    const mediaInfo = getAntideleteMediaInfo(originalMessage);
    const text = getAntideleteText(originalMessage);

    if (!mediaInfo) {
      headerLines.push('📌 Type: Text', '', `💬 Message:\n${text || '(empty)'}`);
      await sendHidetagMessage(sock, destination, { text: headerLines.join('\n') }, mentions);
      return;
    }

    let buffer = null;
    try {
      buffer = await downloadMediaMessage(cached.msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    } catch (err) {
      console.error('gpantideletepro media download error:', err);
    }

    headerLines.push(`📌 Type: ${mediaInfo.type}`);
    if (mediaInfo.fileName) headerLines.push(`📎 File Name: ${mediaInfo.fileName}`);
    if (mediaInfo.caption) headerLines.push('', `💬 Caption:\n${mediaInfo.caption}`);
    const detailText = headerLines.join('\n');

    if (!buffer) {
      headerLines.push('', '⚠️ Media could not be downloaded.');
      await sendHidetagMessage(sock, destination, { text: headerLines.join('\n') }, mentions);
      return;
    }

    if (mediaInfo.type === 'image') {
      await sendHidetagMessage(sock, destination, { image: buffer, caption: detailText }, mentions);
    } else if (mediaInfo.type === 'video') {
      await sendHidetagMessage(sock, destination, { video: buffer, caption: detailText }, mentions);
    } else if (mediaInfo.type === 'document') {
      await sendHidetagMessage(sock, destination, { document: buffer, fileName: mediaInfo.fileName, mimetype: mediaInfo.mimetype, caption: detailText }, mentions);
    } else if (mediaInfo.type === 'sticker') {
      await sendHidetagMessage(sock, destination, { sticker: buffer }, mentions);
      await sendHidetagMessage(sock, destination, { text: detailText }, mentions);
    } else if (mediaInfo.type === 'audio' || mediaInfo.type === 'voice') {
      await sendHidetagMessage(sock, destination, { audio: buffer, mimetype: mediaInfo.type === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg', ptt: mediaInfo.type === 'voice' }, mentions);
      await sendHidetagMessage(sock, destination, { text: detailText }, mentions);
    }
  } catch (err) {
    console.error('handleAntideleteMeRevoke error:', err);
  }
}

const PM_ANTIDELETE_FILE = path.join(__dirname, 'AllJson', 'pmantidelete.json');
const PM_ANTIDELETEME_FILE = path.join(__dirname, 'AllJson', 'pmantideleteme.json');

async function getPMFlag(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

async function setPMFlag(filePath, enabled) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify({ enabled }, null, 2));
}

async function isPMAntideleteEnabled() {
  return getPMFlag(PM_ANTIDELETE_FILE);
}

async function enablePMAntidelete() {
  await setPMFlag(PM_ANTIDELETE_FILE, true);
}

async function disablePMAntidelete() {
  await setPMFlag(PM_ANTIDELETE_FILE, false);
}

async function isPMAntideleteMeEnabled() {
  return getPMFlag(PM_ANTIDELETEME_FILE);
}

async function enablePMAntideleteMe() {
  await setPMFlag(PM_ANTIDELETEME_FILE, true);
}

async function disablePMAntideleteMe() {
  await setPMFlag(PM_ANTIDELETEME_FILE, false);
}

const AUTOTYPING_FILE = path.join(__dirname, 'AllJson', 'autotyping.json');
const AUTOREACT_FILE = path.join(__dirname, 'AllJson', 'autoreact.json');
const ALWAYSONLINE_FILE = path.join(__dirname, 'AllJson', 'alwaysonline.json');
const AUTOSTATUSDOWNLOAD_FILE = path.join(__dirname, 'AllJson', 'autostatusdownload.json');
const AUTOBLOCK_FILE = path.join(__dirname, 'AllJson', 'autoblock.json');
const AUTOCALLEND_FILE = path.join(__dirname, 'AllJson', 'autocallend.json');
const AUTOUNKNOWNSBLOCK_FILE = path.join(__dirname, 'AllJson', 'autounknownsblock.json');
const AUTOREPLY_FILE = path.join(__dirname, 'AllJson', 'autoreply.json');

async function isAutoTypingEnabled() { return getPMFlag(AUTOTYPING_FILE); }
async function enableAutoTyping() { await setPMFlag(AUTOTYPING_FILE, true); }
async function disableAutoTyping() { await setPMFlag(AUTOTYPING_FILE, false); }

async function isAutoReactEnabled() { return getPMFlag(AUTOREACT_FILE); }
async function enableAutoReact() { await setPMFlag(AUTOREACT_FILE, true); }
async function disableAutoReact() { await setPMFlag(AUTOREACT_FILE, false); }

async function isAlwaysOnlineEnabled() { return getPMFlag(ALWAYSONLINE_FILE); }
async function enableAlwaysOnline() { await setPMFlag(ALWAYSONLINE_FILE, true); }
async function disableAlwaysOnline() { await setPMFlag(ALWAYSONLINE_FILE, false); }

async function isAutoStatusDownloadEnabled() { return getPMFlag(AUTOSTATUSDOWNLOAD_FILE); }
async function enableAutoStatusDownload() { await setPMFlag(AUTOSTATUSDOWNLOAD_FILE, true); }
async function disableAutoStatusDownload() { await setPMFlag(AUTOSTATUSDOWNLOAD_FILE, false); }

async function isAutoBlockEnabled() { return getPMFlag(AUTOBLOCK_FILE); }
async function enableAutoBlock() { await setPMFlag(AUTOBLOCK_FILE, true); }
async function disableAutoBlock() { await setPMFlag(AUTOBLOCK_FILE, false); }

async function isAutoCallEndEnabled() { return getPMFlag(AUTOCALLEND_FILE); }
async function enableAutoCallEnd() { await setPMFlag(AUTOCALLEND_FILE, true); }
async function disableAutoCallEnd() { await setPMFlag(AUTOCALLEND_FILE, false); }


async function isAutoUnknownsBlockEnabled() { return getPMFlag(AUTOUNKNOWNSBLOCK_FILE); }
async function enableAutoUnknownsBlock() { await setPMFlag(AUTOUNKNOWNSBLOCK_FILE, true); }
async function disableAutoUnknownsBlock() { await setPMFlag(AUTOUNKNOWNSBLOCK_FILE, false); }

async function isAutoReplyEnabled() { return getPMFlag(AUTOREPLY_FILE); }
async function enableAutoReply() { await setPMFlag(AUTOREPLY_FILE, true); }
async function disableAutoReply() { await setPMFlag(AUTOREPLY_FILE, false); }

const AUTOREPLY_MESSAGE = '🤖 totoloza bune toto';
const AUTOREACT_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮', '👏', '🎉', '✅'];
const AUTOREPLY_COOLDOWN_MS = 30 * 60 * 1000;
if (!global.autoReplyCache) global.autoReplyCache = new Map();
if (!global.knownContactsSet) global.knownContactsSet = new Set();

function registerContactsFromEvent(contacts) {
  try {
    if (!Array.isArray(contacts)) return;
    for (const c of contacts) {
      if (c && c.id && c.name) {
        global.knownContactsSet.add(c.id);
      }
    }
  } catch (err) {
    console.error('registerContactsFromEvent error:', err);
  }
}

function isKnownContact(jid) {
  try {
    return !!(global.knownContactsSet && global.knownContactsSet.has(jid));
  } catch {
    return false;
  }
}

async function handleAutoTyping(sock, msg, jid) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    if (jid === 'status@broadcast') return;
    const enabled = await isAutoTypingEnabled();
    if (!enabled) return;
    await sock.sendPresenceUpdate('composing', jid);
    setTimeout(() => {
      sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }, 3000);
  } catch (err) {
    console.error('handleAutoTyping error:', err);
  }
}

async function handleAutoReact(sock, msg, jid) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    if (jid === 'status@broadcast') return;
    const enabled = await isAutoReactEnabled();
    if (!enabled) return;
    const emoji = AUTOREACT_EMOJIS[Math.floor(Math.random() * AUTOREACT_EMOJIS.length)];
    await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
  } catch (err) {
    console.error('handleAutoReact error:', err);
  }
}

async function runAlwaysOnlineTick(sock) {
  try {
    const enabled = await isAlwaysOnlineEnabled();
    if (!enabled) return;
    await sock.sendPresenceUpdate('available');
  } catch (err) {
    console.error('runAlwaysOnlineTick error:', err);
  }
}

async function handleAutoStatusDownload(sock, msg) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    const enabled = await isAutoStatusDownloadEnabled();
    if (!enabled) return;

    try { await sock.readMessages([msg.key]); } catch (err) { console.error('autostatusdownload readMessages error:', err); }

    const selfJid = getBotSelfJid(sock);
    if (!selfJid) return;

    const senderJid = msg.key.participant || msg.key.remoteJid;
    const senderNumber = senderJid?.split('@')[0] || 'unknown';
    const mediaInfo = getAntideleteMediaInfo(msg.message);

    if (mediaInfo && (mediaInfo.type === 'image' || mediaInfo.type === 'video')) {
      let buffer = null;
      try {
        buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      } catch (err) {
        console.error('autostatusdownload download error:', err);
        return;
      }
      if (!buffer) return;
      const caption = `📥 Status saved from +${senderNumber}${mediaInfo.caption ? `\n\n${mediaInfo.caption}` : ''}`;
      if (mediaInfo.type === 'image') {
        await sock.sendMessage(selfJid, { image: buffer, caption });
      } else {
        await sock.sendMessage(selfJid, { video: buffer, caption });
      }
    } else {
      const text = getAntideleteText(msg.message);
      if (text) {
        await sock.sendMessage(selfJid, { text: `📥 Status text saved from +${senderNumber}\n\n${text}` });
      }
    }
  } catch (err) {
    console.error('handleAutoStatusDownload error:', err);
  }
}

async function handleAutoBlockingDM(sock, msg, jid, sender, isBotOwner) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (isBotOwner) return;
    if (!isPrivateJid(jid)) return;
    const [blockAll, blockUnknown] = await Promise.all([isAutoBlockEnabled(), isAutoUnknownsBlockEnabled()]);
    if (!blockAll && !blockUnknown) return;
    if (blockAll || (blockUnknown && !isKnownContact(sender))) {
      await sock.updateBlockStatus(sender, 'block');
    }
  } catch (err) {
    console.error('handleAutoBlockingDM error:', err);
  }
}

async function handleAutoReply(sock, msg, jid, sender, isBotOwner) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (isBotOwner) return;
    if (!isPrivateJid(jid)) return;
    if (!msg.message || msg.message.protocolMessage) return;
    const enabled = await isAutoReplyEnabled();
    if (!enabled) return;
    const body = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || msg.message?.videoMessage?.caption
      || '';
    if (!body) return;
    const cacheKey = `${jid}::${sender}`;
    const now = Date.now();
    const last = global.autoReplyCache.get(cacheKey);
    if (last && (now - last) < AUTOREPLY_COOLDOWN_MS) return;
    global.autoReplyCache.set(cacheKey, now);
    setTimeout(() => global.autoReplyCache.delete(cacheKey), AUTOREPLY_COOLDOWN_MS);
    await reply(sock, jid, msg, AUTOREPLY_MESSAGE);
  } catch (err) {
    console.error('handleAutoReply error:', err);
  }
}

async function handleIncomingCall(sock, calls) {
  try {
    if (!Array.isArray(calls)) return;
    const callEndEnabled = await isAutoCallEndEnabled();
    if (!callEndEnabled) return;
    for (const call of calls) {
      if (!call || !call.id || !call.from) continue;
      if (call.status !== 'offer') continue;
      try { await sock.rejectCall(call.id, call.from); } catch (err) { console.error('autocallend reject error:', err); }
    }
  } catch (err) {
    console.error('handleIncomingCall error:', err);
  }
}

const AUTOSTATUSVIEWS_FILE = path.join(__dirname, 'AllJson', 'autostatusviews.json');
const AUTOSTATUSREACT_FILE = path.join(__dirname, 'AllJson', 'autostatusreact.json');
const AUTOREAD_FILE = path.join(__dirname, 'AllJson', 'autoread.json');
const AUTORECORDING_FILE = path.join(__dirname, 'AllJson', 'autorecording.json');
const AUTOINVISIBLE_FILE = path.join(__dirname, 'AllJson', 'autoinvisible.json');
const HIDERECEIPTS_FILE = path.join(__dirname, 'AllJson', 'hidereceipts.json');
const HIDELASTSEEN_FILE = path.join(__dirname, 'AllJson', 'hidelastseen.json');
const HIDEPROFILEPIC_FILE = path.join(__dirname, 'AllJson', 'hideprofilepic.json');
const BLOCKGROUPADD_FILE = path.join(__dirname, 'AllJson', 'blockgroupadd.json');
const BLOCKUNKNOWNCALLS_FILE = path.join(__dirname, 'AllJson', 'blockunknowncalls.json');

async function isAutoStatusViewsEnabled() { return getPMFlag(AUTOSTATUSVIEWS_FILE); }
async function enableAutoStatusViews() { await setPMFlag(AUTOSTATUSVIEWS_FILE, true); }
async function disableAutoStatusViews() { await setPMFlag(AUTOSTATUSVIEWS_FILE, false); }

async function isAutoStatusReactEnabled() { return getPMFlag(AUTOSTATUSREACT_FILE); }
async function enableAutoStatusReact() { await setPMFlag(AUTOSTATUSREACT_FILE, true); }
async function disableAutoStatusReact() { await setPMFlag(AUTOSTATUSREACT_FILE, false); }

async function isAutoReadEnabled() { return getPMFlag(AUTOREAD_FILE); }
async function enableAutoRead() { await setPMFlag(AUTOREAD_FILE, true); }
async function disableAutoRead() { await setPMFlag(AUTOREAD_FILE, false); }

async function isAutoRecordingEnabled() { return getPMFlag(AUTORECORDING_FILE); }
async function enableAutoRecording() { await setPMFlag(AUTORECORDING_FILE, true); }
async function disableAutoRecording() { await setPMFlag(AUTORECORDING_FILE, false); }

async function isAutoInvisibleEnabled() { return getPMFlag(AUTOINVISIBLE_FILE); }
async function enableAutoInvisible() { await setPMFlag(AUTOINVISIBLE_FILE, true); }
async function disableAutoInvisible() { await setPMFlag(AUTOINVISIBLE_FILE, false); }

async function isHideReceiptsEnabled() { return getPMFlag(HIDERECEIPTS_FILE); }
async function enableHideReceipts() { await setPMFlag(HIDERECEIPTS_FILE, true); }
async function disableHideReceipts() { await setPMFlag(HIDERECEIPTS_FILE, false); }

async function isHideLastSeenEnabled() { return getPMFlag(HIDELASTSEEN_FILE); }
async function enableHideLastSeen() { await setPMFlag(HIDELASTSEEN_FILE, true); }
async function disableHideLastSeen() { await setPMFlag(HIDELASTSEEN_FILE, false); }

async function isHideProfilePicEnabled() { return getPMFlag(HIDEPROFILEPIC_FILE); }
async function enableHideProfilePic() { await setPMFlag(HIDEPROFILEPIC_FILE, true); }
async function disableHideProfilePic() { await setPMFlag(HIDEPROFILEPIC_FILE, false); }

async function isBlockGroupAddEnabled() { return getPMFlag(BLOCKGROUPADD_FILE); }
async function enableBlockGroupAdd() { await setPMFlag(BLOCKGROUPADD_FILE, true); }
async function disableBlockGroupAdd() { await setPMFlag(BLOCKGROUPADD_FILE, false); }

async function isBlockUnknownCallsEnabled() { return getPMFlag(BLOCKUNKNOWNCALLS_FILE); }
async function enableBlockUnknownCalls() { await setPMFlag(BLOCKUNKNOWNCALLS_FILE, true); }
async function disableBlockUnknownCalls() { await setPMFlag(BLOCKUNKNOWNCALLS_FILE, false); }

async function handleAutoStatusViews(sock, msg) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    const enabled = await isAutoStatusViewsEnabled();
    if (!enabled) return;
    await sock.readMessages([msg.key]);
  } catch (err) {
    console.error('handleAutoStatusViews error:', err);
  }
}

async function handleAutoStatusReact(sock, msg) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    const enabled = await isAutoStatusReactEnabled();
    if (!enabled) return;
    const participant = msg.key.participant || msg.key.remoteJid;
    const emoji = AUTOREACT_EMOJIS[Math.floor(Math.random() * AUTOREACT_EMOJIS.length)];
    await sock.sendMessage(
      'status@broadcast',
      { react: { text: emoji, key: msg.key } },
      { statusJidList: [participant] }
    );
  } catch (err) {
    console.error('handleAutoStatusReact error:', err);
  }
}

async function handleAutoRead(sock, msg, jid) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    if (jid === 'status@broadcast') return;
    const enabled = await isAutoReadEnabled();
    if (!enabled) return;
    await sock.readMessages([msg.key]);
  } catch (err) {
    console.error('handleAutoRead error:', err);
  }
}

async function handleAutoRecording(sock, msg, jid) {
  try {
    if (!msg?.key || msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    if (jid === 'status@broadcast') return;
    const enabled = await isAutoRecordingEnabled();
    if (!enabled) return;
    await sock.sendPresenceUpdate('recording', jid);
    setTimeout(() => {
      sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }, 3000);
  } catch (err) {
    console.error('handleAutoRecording error:', err);
  }
}

async function applyAutoInvisible(sock, enabled) {
  try {
    await sock.updateOnlinePrivacy(enabled ? 'match_last_seen' : 'all');
  } catch (err) {
    console.error('applyAutoInvisible error:', err);
  }
}

async function applyHideReceipts(sock, enabled) {
  try {
    await sock.updateReadReceiptsPrivacy(enabled ? 'none' : 'all');
  } catch (err) {
    console.error('applyHideReceipts error:', err);
  }
}

async function applyHideLastSeen(sock, enabled) {
  try {
    await sock.updateLastSeenPrivacy(enabled ? 'none' : 'all');
  } catch (err) {
    console.error('applyHideLastSeen error:', err);
  }
}

async function applyHideProfilePic(sock, enabled) {
  try {
    await sock.updateProfilePicturePrivacy(enabled ? 'contacts' : 'all');
  } catch (err) {
    console.error('applyHideProfilePic error:', err);
  }
}

async function applyBlockGroupAdd(sock, enabled) {
  try {
    await sock.updateGroupsAddPrivacy(enabled ? 'contacts' : 'all');
  } catch (err) {
    console.error('applyBlockGroupAdd error:', err);
  }
}

async function applyBlockUnknownCalls(sock, enabled) {
  try {
    await sock.updateCallPrivacy(enabled ? 'known' : 'all');
  } catch (err) {
    console.error('applyBlockUnknownCalls error:', err);
  }
}

async function cachePMAntideleteMessage(jid, msg) {
  try {
    if (!isPrivateJid(jid)) return;
    if (msg.key.fromMe) return;
    if (!msg.message || msg.message.protocolMessage) return;
    const id = msg.key.id;
    if (!id) return;
    const enabled = await isPMAntideleteEnabled();
    const enabledMe = await isPMAntideleteMeEnabled();
    if (!enabled && !enabledMe) return;
    const key = antideleteCacheKey(jid, id);
    antideleteCache.set(key, {
      msg,
      senderJid: msg.key.participant || msg.key.remoteJid,
      timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
    });
    setTimeout(() => antideleteCache.delete(key), ANTIDELETE_CACHE_TTL);
  } catch (err) {
    console.error('cachePMAntideleteMessage error:', err);
  }
}

async function handlePMAntideleteRevoke(sock, msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!isPrivateJid(jid)) return;

    const enabled = await isPMAntideleteEnabled();
    if (!enabled) return;

    const protocolMsg = msg.message?.protocolMessage;
    if (!protocolMsg || !protocolMsg.key) return;
    const revokeType = proto?.Message?.ProtocolMessage?.Type?.REVOKE ?? 0;
    if (protocolMsg.type !== revokeType) return;

    const deletedKey = protocolMsg.key;
    const cacheKeyStr = antideleteCacheKey(jid, deletedKey.id);
    const cached = antideleteCache.get(cacheKeyStr);

    const deleterNumber = normalizeNum(jid);
    const pmMention = {
      forwardingScore: 999,
      isForwarded: true,
      mentionedJid: [jid],
      forwardedNewsletterMessageInfo: {
        newsletterName: global.chname,
        newsletterJid: global.chid,
      }
    };
    const { time, date } = formatDateTime();

    const headerLines = [
      '🗑️ *PM ANTIDELETE - Message Deleted*',
      '',
      `👤 Contact: @${deleterNumber}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];

    if (!cached) {
      headerLines.push('', '⚠️ Original content could not be recovered.');
      await sock.sendMessage(jid, { text: headerLines.join('\n'), contextInfo: pmMention });
      return;
    }

    const originalMessage = cached.msg.message;
    const mediaInfo = getAntideleteMediaInfo(originalMessage);
    const text = getAntideleteText(originalMessage);

    if (!mediaInfo) {
      headerLines.push('📌 Type: Text', '', `💬 Message:\n${text || '(empty)'}`);
      await sock.sendMessage(jid, { text: headerLines.join('\n'), contextInfo: pmMention });
      return;
    }

    let buffer = null;
    try {
      buffer = await downloadMediaMessage(cached.msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    } catch (err) {
      console.error('pmantidelete media download error:', err);
    }

    headerLines.push(`📌 Type: ${mediaInfo.type}`);
    if (mediaInfo.fileName) headerLines.push(`📎 File Name: ${mediaInfo.fileName}`);
    if (mediaInfo.caption) headerLines.push('', `💬 Caption:\n${mediaInfo.caption}`);
    const detailText = headerLines.join('\n');

    if (!buffer) {
      headerLines.push('', '⚠️ Media could not be downloaded.');
      await sock.sendMessage(jid, { text: headerLines.join('\n'), contextInfo: pmMention });
      return;
    }

    if (mediaInfo.type === 'image') {
      await sock.sendMessage(jid, { image: buffer, caption: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'video') {
      await sock.sendMessage(jid, { video: buffer, caption: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'document') {
      await sock.sendMessage(jid, { document: buffer, fileName: mediaInfo.fileName, mimetype: mediaInfo.mimetype, caption: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'sticker') {
      await sock.sendMessage(jid, { sticker: buffer });
      await sock.sendMessage(jid, { text: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'audio' || mediaInfo.type === 'voice') {
      await sock.sendMessage(jid, { audio: buffer, mimetype: mediaInfo.type === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg', ptt: mediaInfo.type === 'voice' });
      await sock.sendMessage(jid, { text: detailText, contextInfo: pmMention });
    }
  } catch (err) {
    console.error('handlePMAntideleteRevoke error:', err);
  }
}

async function handlePMAntideleteMeRevoke(sock, msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!isPrivateJid(jid)) return;

    const enabled = await isPMAntideleteMeEnabled();
    if (!enabled) return;

    const protocolMsg = msg.message?.protocolMessage;
    if (!protocolMsg || !protocolMsg.key) return;
    const revokeType = proto?.Message?.ProtocolMessage?.Type?.REVOKE ?? 0;
    if (protocolMsg.type !== revokeType) return;

    const destination = getBotSelfJid(sock);
    if (!destination) return;

    const deletedKey = protocolMsg.key;
    const cacheKeyStr = antideleteCacheKey(jid, deletedKey.id);
    const cached = antideleteCache.get(cacheKeyStr);

    const deleterNumber = normalizeNum(jid);
    const pmMention = {
      forwardingScore: 999,
      isForwarded: true,
      mentionedJid: [jid],
      forwardedNewsletterMessageInfo: {
        newsletterName: global.chname,
        newsletterJid: global.chid,
      }
    };
    const { time, date } = formatDateTime();

    const headerLines = [
      '🗑️ *PM ANTIDELETE (Silent) - Message Deleted*',
      '',
      `👤 Contact: @${deleterNumber}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];

    if (!cached) {
      headerLines.push('', '⚠️ Original content could not be recovered.');
      await sock.sendMessage(destination, { text: headerLines.join('\n'), contextInfo: pmMention });
      return;
    }

    const originalMessage = cached.msg.message;
    const mediaInfo = getAntideleteMediaInfo(originalMessage);
    const text = getAntideleteText(originalMessage);

    if (!mediaInfo) {
      headerLines.push('📌 Type: Text', '', `💬 Message:\n${text || '(empty)'}`);
      await sock.sendMessage(destination, { text: headerLines.join('\n'), contextInfo: pmMention });
      return;
    }

    let buffer = null;
    try {
      buffer = await downloadMediaMessage(cached.msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    } catch (err) {
      console.error('pmantideleteme media download error:', err);
    }

    headerLines.push(`📌 Type: ${mediaInfo.type}`);
    if (mediaInfo.fileName) headerLines.push(`📎 File Name: ${mediaInfo.fileName}`);
    if (mediaInfo.caption) headerLines.push('', `💬 Caption:\n${mediaInfo.caption}`);
    const detailText = headerLines.join('\n');

    if (!buffer) {
      headerLines.push('', '⚠️ Media could not be downloaded.');
      await sock.sendMessage(destination, { text: headerLines.join('\n'), contextInfo: pmMention });
      return;
    }

    if (mediaInfo.type === 'image') {
      await sock.sendMessage(destination, { image: buffer, caption: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'video') {
      await sock.sendMessage(destination, { video: buffer, caption: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'document') {
      await sock.sendMessage(destination, { document: buffer, fileName: mediaInfo.fileName, mimetype: mediaInfo.mimetype, caption: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'sticker') {
      await sock.sendMessage(destination, { sticker: buffer });
      await sock.sendMessage(destination, { text: detailText, contextInfo: pmMention });
    } else if (mediaInfo.type === 'audio' || mediaInfo.type === 'voice') {
      await sock.sendMessage(destination, { audio: buffer, mimetype: mediaInfo.type === 'voice' ? 'audio/ogg; codecs=opus' : 'audio/mpeg', ptt: mediaInfo.type === 'voice' });
      await sock.sendMessage(destination, { text: detailText, contextInfo: pmMention });
    }
  } catch (err) {
    console.error('handlePMAntideleteMeRevoke error:', err);
  }
}


const SPAM_FILE = path.join(__dirname, 'AllJson', 'spam.json');

async function getSpamSettings() {
  try {
    const raw = await fsp.readFile(SPAM_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSpamSettings(settings) {
  await fsp.mkdir(path.dirname(SPAM_FILE), { recursive: true });
  await fsp.writeFile(SPAM_FILE, JSON.stringify(settings, null, 2));
}

async function getGroupSpamConfig(jid) {
  const settings = await getSpamSettings();
  const cfg = settings[jid] || {};
  return {
    enabled: !!cfg.enabled,
    timeMs: typeof cfg.timeMs === 'number' && cfg.timeMs > 0 ? cfg.timeMs : 10000,
    postLimit: typeof cfg.postLimit === 'number' && cfg.postLimit > 0 ? cfg.postLimit : 5,
  };
}

async function setGroupSpamConfig(jid, updates) {
  const settings = await getSpamSettings();
  const current = settings[jid] || {};
  settings[jid] = { ...current, ...updates };
  await saveSpamSettings(settings);
  return settings[jid];
}

function parseTimeArgToMs(args) {
  if (!args || args.length === 0) return null;
  const value = parseFloat(args[0]);
  if (isNaN(value) || value <= 0) return null;
  const unitRaw = (args[1] || 'seconds').toLowerCase();
  let multiplier;
  if (unitRaw.startsWith('sec')) multiplier = 1000;
  else if (unitRaw.startsWith('min')) multiplier = 60000;
  else if (unitRaw.startsWith('hour') || unitRaw.startsWith('hr')) multiplier = 3600000;
  else return null;
  return Math.round(value * multiplier);
}

function parsePostArgToCount(args) {
  if (!args || args.length === 0) return null;
  const value = parseInt(args[0], 10);
  if (isNaN(value) || value <= 0) return null;
  return value;
}

function formatMs(ms) {
  if (ms % 60000 === 0) {
    const mins = ms / 60000;
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  const secs = ms / 1000;
  return `${secs} second${secs === 1 ? '' : 's'}`;
}

async function checkAndHandleSpam(sock, jid, msg, sender, senderNumber, isBotOwner) {
  if (isBotOwner) return false;
  if (!isGroupJid(jid)) return false;

  const cfg = await getGroupSpamConfig(jid);
  if (!cfg.enabled) return false;

  const metadata = await getGroupMetadataSafe(sock, jid);
  if (!metadata) return false;

  if (await isSenderAdmin(metadata, sender, sock)) return false;
  if (!(await isBotAdmin(metadata, sock.user.id, sock))) return false;

  if (!global.spamTracker) global.spamTracker = new Map();
  const trackKey = `${jid}::${senderNumber}`;
  const now = Date.now();
  let entry = global.spamTracker.get(trackKey);

  if (!entry || (now - entry.firstTs) > cfg.timeMs) {
    entry = { firstTs: now, messages: [] };
  }
  entry.messages.push(msg.key);
  global.spamTracker.set(trackKey, entry);

  if (entry.messages.length < cfg.postLimit) {
    return false;
  }

  global.spamTracker.delete(trackKey);

  try {
    await sock.groupSettingUpdate(jid, 'announcement');

    for (const key of entry.messages) {
      try {
        await sock.sendMessage(jid, { delete: key });
      } catch {}
    }

    const senderParticipant = metadata.participants.find(p => {
      const idNum = p.id?.split('@')[0].split(':')[0];
      const jidNum = p.jid?.split('@')[0].split(':')[0];
      return idNum === senderNumber || jidNum === senderNumber;
    });
    const senderMentionId = senderParticipant?.id || sender;
    const allMentions = metadata.participants.map(p => p.id);

    await sock.sendMessage(jid, {
      text: `🚫 @${senderMentionId.split('@')[0]} was detected spamming! (${entry.messages.length} messages within ${formatMs(cfg.timeMs)})\nAll of their messages have been deleted and they are being removed from the group.`,
      mentions: allMentions
    });

    try {
      await sock.groupParticipantsUpdate(jid, [senderMentionId], 'remove');
    } catch (err) {
      console.error(err);
    }

    await sock.groupSettingUpdate(jid, 'not_announcement');
  } catch (err) {
    console.error(err);
    try { await sock.groupSettingUpdate(jid, 'not_announcement'); } catch {}
  }

  return true;
}

function isGroupJid(jid) {
  return jid.endsWith('@g.us');
}

function isPrivateJid(jid) {
  return !!jid && jid.endsWith('@s.whatsapp.net');
}

const ANTILINK_FILE = path.join(__dirname, 'AllJson', 'antilink.json');

const TERMINAL_LOG_FILE = path.join(__dirname, 'AllJson', 'terminallog.json');

async function getTerminalLogEnabled() {
  try {
    const raw = await fsp.readFile(TERMINAL_LOG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.enabled !== false;
  } catch {
    return true;
  }
}

async function setTerminalLogEnabled(enabled) {
  await fsp.mkdir(path.dirname(TERMINAL_LOG_FILE), { recursive: true });
  await fsp.writeFile(TERMINAL_LOG_FILE, JSON.stringify({ enabled }, null, 2));
}

const ANTILINK_ALIASES = {
  youtube: ['youtube.com', 'youtu.be'],
  telegram: ['t.me', 'telegram.me', 'telegram.org', 'telegram.dog'],
  whatsapp: ['whatsapp.com', 'wa.me', 'chat.whatsapp.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.watch', 'fb.me'],
  instagram: ['instagram.com', 'instagr.am'],
  tiktok: ['tiktok.com', 'vm.tiktok.com'],
  twitter: ['twitter.com', 'x.com', 't.co'],
  discord: ['discord.gg', 'discord.com', 'discordapp.com'],
  snapchat: ['snapchat.com', 'snap.com'],
  linkedin: ['linkedin.com'],
};

const ANTILINK_URL_REGEX = /(https?:\/\/\S+)|(www\.\S+)|(\b[a-zA-Z0-9][a-zA-Z0-9-]*\.(?:com|net|org|me|gg|io|co|ly|be|tv|app|xyz|info|link|click)(?:\/\S*)?\b)/gi;

function extractLinks(text) {
  if (!text) return [];
  const matches = text.match(ANTILINK_URL_REGEX);
  return matches ? [...new Set(matches)] : [];
}

function isWatchedLink(link, keywords) {
  const lowerLink = link.toLowerCase();
  return keywords.some((keyword) => {
    const kw = keyword.toLowerCase();
    const aliases = ANTILINK_ALIASES[kw];
    if (aliases) return aliases.some((alias) => lowerLink.includes(alias));
    return lowerLink.includes(kw);
  });
}

async function getAntilinkSettings() {
  try {
    const raw = await fsp.readFile(ANTILINK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveAntilinkSettings(settings) {
  await fsp.mkdir(path.dirname(ANTILINK_FILE), { recursive: true });
  await fsp.writeFile(ANTILINK_FILE, JSON.stringify(settings, null, 2));
}

async function getGroupAntilinkConfig(jid) {
  const settings = await getAntilinkSettings();
  const cfg = settings[jid] || {};
  return {
    mode: (cfg.mode === 'del' || cfg.mode === 'kick') ? cfg.mode : 'off',
    links: Array.isArray(cfg.links) ? cfg.links : [],
  };
}

async function setGroupAntilinkMode(jid, mode) {
  const settings = await getAntilinkSettings();
  const current = settings[jid] || {};
  settings[jid] = { mode, links: Array.isArray(current.links) ? current.links : [] };
  await saveAntilinkSettings(settings);
}

async function addAntilinkKeyword(jid, keyword) {
  const settings = await getAntilinkSettings();
  const current = settings[jid] || {};
  const links = Array.isArray(current.links) ? current.links : [];
  const kw = keyword.toLowerCase();
  if (!links.includes(kw)) links.push(kw);
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', links };
  await saveAntilinkSettings(settings);
  return links;
}

async function removeAntilinkKeyword(jid, keyword) {
  const settings = await getAntilinkSettings();
  const current = settings[jid] || {};
  const links = Array.isArray(current.links) ? current.links : [];
  const kw = keyword.toLowerCase();
  const filtered = links.filter((l) => l !== kw);
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', links: filtered };
  await saveAntilinkSettings(settings);
  return filtered;
}

async function clearAntilinkKeywords(jid) {
  const settings = await getAntilinkSettings();
  const current = settings[jid] || {};
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', links: [] };
  await saveAntilinkSettings(settings);
}

const WARN_FILE = path.join(__dirname, 'AllJson', 'warnings.json');
const MAX_WARNS = 3;

async function getWarnData() {
  try {
    const raw = await fsp.readFile(WARN_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveWarnData(data) {
  await fsp.mkdir(path.dirname(WARN_FILE), { recursive: true });
  await fsp.writeFile(WARN_FILE, JSON.stringify(data, null, 2));
}

async function addWarn(jid, number) {
  const data = await getWarnData();
  if (!data[jid]) data[jid] = {};
  data[jid][number] = (data[jid][number] || 0) + 1;
  await saveWarnData(data);
  return data[jid][number];
}

async function getWarnCount(jid, number) {
  const data = await getWarnData();
  return (data[jid] && data[jid][number]) || 0;
}

async function resetWarnUser(jid, number) {
  const data = await getWarnData();
  if (data[jid]) delete data[jid][number];
  await saveWarnData(data);
}

async function resetWarnAll(jid) {
  const data = await getWarnData();
  data[jid] = {};
  await saveWarnData(data);
}

async function checkAndHandleAntilink(sock, jid, msg, sender, senderNumber, isBotOwner) {
  if (isBotOwner) return false;
  if (!isGroupJid(jid)) return false;

  const cfg = await getGroupAntilinkConfig(jid);
  if (cfg.mode === 'off') return false;
  if (!cfg.links || cfg.links.length === 0) return false;

  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
  if (!body) return false;

  const foundLinks = extractLinks(body);
  if (foundLinks.length === 0) return false;

  const matched = foundLinks.some((link) => isWatchedLink(link, cfg.links));
  if (!matched) return false;

  const metadata = await getGroupMetadataSafe(sock, jid);
  if (!metadata) return false;

  if (await isSenderAdmin(metadata, sender, sock)) return false;
  if (!(await isBotAdmin(metadata, sock.user.id, sock))) return false;

  try {
    await sock.sendMessage(jid, { delete: msg.key });
  } catch (err) {
    console.error(err);
  }

  const senderParticipant = metadata.participants.find((p) => {
    const idNum = p.id?.split('@')[0].split(':')[0];
    const jidNum = p.jid?.split('@')[0].split(':')[0];
    return idNum === senderNumber || jidNum === senderNumber;
  });
  const senderMentionId = senderParticipant?.id || sender;
  const senderMentionNumber = senderMentionId.split('@')[0];
  const allMentions = metadata.participants.map((p) => p.id);
  const otherMentions = allMentions.filter((id) => normalizeNum(id) !== normalizeNum(senderMentionId));
  const hideMentions = [senderMentionId, ...otherMentions];

  if (cfg.mode === 'kick') {
    await sendHidetagMessage(sock, jid, { text: `🚫 @${senderMentionNumber} your message contained a restricted link and has been deleted! You are being removed from the group.` }, hideMentions);
    try {
      await sock.groupParticipantsUpdate(jid, [senderMentionId], 'remove');
    } catch (err) {
      console.error(err);
    }
  } else {
    await sendHidetagMessage(sock, jid, { text: `⚠️ @${senderMentionNumber} sending links is not allowed here! Your message has been deleted.` }, hideMentions);
  }

  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGroupMetadataSafe(sock, jid) {
  try {
    return await sock.groupMetadata(jid);
  } catch {
    return null;
  }
}

async function ensureGroupMetadata(sock, jid, sender, msg) {
  const metadata = await getGroupMetadataSafe(sock, jid);
  if (!metadata) {
    await reply(sock, jid, msg, '❌ Group metadata not found!', { mentions: [sender] });
    return null;
  }
  return metadata;
}

function getMentionedOrQuoted(msg) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
    || msg.message?.imageMessage?.contextInfo
    || msg.message?.videoMessage?.contextInfo
    || {};
  const mentioned = contextInfo.mentionedJid || [];
  if (mentioned.length > 0) return mentioned;
  if (contextInfo.participant) return [contextInfo.participant];
  return [];
}

function getQuotedKey(msg, jid) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
    || msg.message?.imageMessage?.contextInfo
    || msg.message?.videoMessage?.contextInfo;
  if (!contextInfo || !contextInfo.stanzaId || !contextInfo.participant) return null;
  return {
    remoteJid: jid,
    fromMe: false,
    id: contextInfo.stanzaId,
    participant: contextInfo.participant
  };
}

function normalizeNum(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : null;
}

function isBotParticipant(p, botJid) {
  const botNum = normalizeNum(botJid);
  return normalizeNum(p.id) === botNum || normalizeNum(p.jid) === botNum;
}

async function resolveNumberCandidates(sock, jidOrNum, metadata) {
  const candidates = new Set();
  if (!jidOrNum) return candidates;
  const raw = jidOrNum.includes('@') ? jidOrNum.split('@')[0].split(':')[0] : jidOrNum.split(':')[0];
  candidates.add(raw);

  if (metadata && Array.isArray(metadata.participants)) {
    const match = metadata.participants.find(p => {
      const idNum = p.id?.split('@')[0].split(':')[0];
      const jidNum = p.jid?.split('@')[0].split(':')[0];
      return idNum === raw || jidNum === raw;
    });
    if (match) {
      if (match.id) candidates.add(match.id.split('@')[0].split(':')[0]);
      if (match.jid) candidates.add(match.jid.split('@')[0].split(':')[0]);
    }
  }

  try {
    const lidCacheMap = await getLidCache();
    if (lidCacheMap[raw]) candidates.add(lidCacheMap[raw]);
    for (const [lidNum, phoneNum] of Object.entries(lidCacheMap)) {
      if (phoneNum === raw) candidates.add(lidNum);
    }
  } catch {}

  try {
    const fullJid = jidOrNum.includes('@') ? jidOrNum : `${raw}@lid`;
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(fullJid);
    if (pn) candidates.add(pn.split('@')[0].split(':')[0]);
  } catch {}

  return candidates;
}

async function isSenderAdmin(metadata, sender, sock) {
  const senderCandidates = await resolveNumberCandidates(sock, sender, metadata);
  return metadata.participants.some(p => {
    const idNum = p.id?.split('@')[0].split(':')[0];
    const jidNum = p.jid?.split('@')[0].split(':')[0];
    return (senderCandidates.has(idNum) || senderCandidates.has(jidNum)) && p.admin;
  });
}

async function isBotAdmin(metadata, botJid, sock) {
  const botCandidates = await resolveNumberCandidates(sock, botJid, metadata);
  return metadata.participants.some(p => {
    const idNum = p.id?.split('@')[0].split(':')[0];
    const jidNum = p.jid?.split('@')[0].split(':')[0];
    return (botCandidates.has(idNum) || botCandidates.has(jidNum)) && p.admin;
  });
}

async function resolveParticipantNumber(sock, p) {
  const displayId = p.id || p.jid || '';
  const candidates = [p.jid, p.id].filter(Boolean);
  const real = candidates.find(j => j.endsWith('@s.whatsapp.net'));
  if (real) {
    return { number: real.split('@')[0], id: displayId };
  }
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(displayId);
    if (pn) {
      return { number: pn.split('@')[0], id: displayId };
    }
  } catch {}
  return { number: displayId.split('@')[0] || 'unknown', id: displayId || 'unknown' };
}

const LIDCACHE_FILE = path.join(__dirname, 'AllJson', 'lidCache.json');
const LIDCACHE_REFRESH_MS = 15 * 60 * 1000;

async function getLidCache() {
  try {
    const raw = await fsp.readFile(LIDCACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveLidCache(map) {
  await fsp.mkdir(path.dirname(LIDCACHE_FILE), { recursive: true });
  await fsp.writeFile(LIDCACHE_FILE, JSON.stringify(map, null, 2));
}

async function mergeLidCache(entries) {
  if (!entries || Object.keys(entries).length === 0) return;
  const current = await getLidCache();
  const merged = { ...current, ...entries };
  await saveLidCache(merged);
}

async function harvestLidEntry(sock, p, entries) {
  const idA = p.id || '';
  const idB = p.jid || '';
  const lidCandidate = [idA, idB].find(j => j && j.endsWith('@lid'));
  if (!lidCandidate) return;
  const lidNumber = normalizeNum(lidCandidate);
  if (!lidNumber) return;
  const realCandidate = [idA, idB].find(j => j && j.endsWith('@s.whatsapp.net'));
  if (realCandidate) {
    entries[lidNumber] = normalizeNum(realCandidate);
    return;
  }
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(lidCandidate);
    if (pn) {
      entries[lidNumber] = normalizeNum(pn);
    }
  } catch {}
}

async function harvestLidEntriesFromMetadata(sock, metadata) {
  const entries = {};
  if (!metadata || !Array.isArray(metadata.participants)) return entries;
  for (const p of metadata.participants) {
    await harvestLidEntry(sock, p, entries);
  }
  return entries;
}

async function refreshLidCache(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const entries = {};
    for (const gJid of Object.keys(groups || {})) {
      const metadata = groups[gJid];
      for (const p of (metadata.participants || [])) {
        await harvestLidEntry(sock, p, entries);
      }
    }
    await mergeLidCache(entries);
  } catch (err) {
    const isRateLimit = err?.data === 429 || /rate-overlimit/i.test(err?.message || '');
    if (!isRateLimit) console.error('lidCache refresh error:', err);
  }
}

function startLidCacheAutoRefresh(sock) {
  refreshLidCache(sock).catch(() => {});
  return setInterval(() => {
    refreshLidCache(sock).catch(() => {});
  }, LIDCACHE_REFRESH_MS);
}

async function resolveDisplayNumber(sock, participantId, metadata, lidCacheMap) {
  if (!participantId) return 'unknown';
  if (participantId.endsWith('@s.whatsapp.net')) {
    return normalizeNum(participantId);
  }
  const lidNumber = normalizeNum(participantId);
  if (metadata && Array.isArray(metadata.participants)) {
    const match = metadata.participants.find(p => normalizeNum(p.id) === lidNumber || normalizeNum(p.jid) === lidNumber);
    if (match) {
      const real = [match.jid, match.id].find(j => j && j.endsWith('@s.whatsapp.net'));
      if (real) return normalizeNum(real);
    }
  }
  if (lidCacheMap && lidCacheMap[lidNumber]) {
    return lidCacheMap[lidNumber];
  }
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(participantId);
    if (pn) return normalizeNum(pn);
  } catch {}
  return lidNumber;
}

function formatDateTime() {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Asia/Karachi',
  });
  const date = now.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Karachi',
  });
  return { time, date };
}

const ACTION_LABELS = {
  add: 'Member Added',
  remove: 'Member Removed',
  promote: 'Promoted To Admin',
  demote: 'Demoted From Admin',
};

const GPSAFE_FILE = path.join(__dirname, 'AllJson', 'gpsafe.json');
const SAFEADMINS_FILE = path.join(__dirname, 'AllJson', 'safeadmins.json');

async function getGpSafeSettings() {
  try {
    const raw = await fsp.readFile(GPSAFE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveGpSafeSettings(settings) {
  await fsp.mkdir(path.dirname(GPSAFE_FILE), { recursive: true });
  await fsp.writeFile(GPSAFE_FILE, JSON.stringify(settings, null, 2));
}

async function getGpSafeMode(jid) {
  const settings = await getGpSafeSettings();
  return settings[jid] || null;
}

async function setGpSafeMode(jid, mode) {
  const settings = await getGpSafeSettings();
  if (mode === 'off') {
    delete settings[jid];
  } else {
    settings[jid] = mode;
  }
  await saveGpSafeSettings(settings);
}

async function getSafeAdmins() {
  try {
    const raw = await fsp.readFile(SAFEADMINS_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveSafeAdmins(list) {
  await fsp.mkdir(path.dirname(SAFEADMINS_FILE), { recursive: true });
  await fsp.writeFile(SAFEADMINS_FILE, JSON.stringify(list, null, 2));
}

async function addSafeAdmin(number) {
  const list = await getSafeAdmins();
  if (!list.includes(number)) {
    list.push(number);
    await saveSafeAdmins(list);
  }
  return list;
}

async function removeSafeAdmin(number) {
  const list = await getSafeAdmins();
  const filtered = list.filter(n => n !== number);
  await saveSafeAdmins(filtered);
  return filtered;
}

async function clearSafeAdmins() {
  await saveSafeAdmins([]);
}

const GPSETTINGS_FILE = path.join(__dirname, 'AllJson', 'gpsettings.json');

async function getGpSettingsSettings() {
  try {
    const raw = await fsp.readFile(GPSETTINGS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveGpSettingsSettings(settings) {
  await fsp.mkdir(path.dirname(GPSETTINGS_FILE), { recursive: true });
  await fsp.writeFile(GPSETTINGS_FILE, JSON.stringify(settings, null, 2));
}

async function getGpSettingsMode(jid) {
  const settings = await getGpSettingsSettings();
  return settings[jid] || null;
}

async function setGpSettingsMode(jid, mode) {
  const settings = await getGpSettingsSettings();
  if (mode === 'off') {
    delete settings[jid];
  } else {
    settings[jid] = mode;
  }
  await saveGpSettingsSettings(settings);
}

const GPSAFE_ACTIONS = ['add', 'remove', 'promote', 'demote'];

async function handleGpSafeProtection(sock, update) {
  try {
    const jid = update?.id;
    if (!jid || !isGroupJid(jid)) return;

    const mode = await getGpSafeMode(jid);
    if (!mode) return;

    const action = update?.action;
    if (!GPSAFE_ACTIONS.includes(action)) return;

    const author = update?.author || update?.authorPn || null;
    if (!author) return;

    const rawParticipants = Array.isArray(update?.participants) ? update.participants : [];
    const participantIds = rawParticipants
      .map(p => (typeof p === 'string' ? p : (p?.id || p?.jid)))
      .filter(Boolean);
    if (participantIds.length === 0) return;

    const metadata = await getGroupMetadataSafe(sock, jid);
    if (!metadata) return;

    const botJid = sock?.user?.id || null;
    const botCandidates = await resolveNumberCandidates(sock, botJid, metadata);
    const authorCandidates = await resolveNumberCandidates(sock, author, metadata);
    const authorIsBot = [...authorCandidates].some(c => botCandidates.has(c));
    if (authorIsBot) return;

    const lidCacheMap = await getLidCache();
const authorNumber = await resolveDisplayNumber(sock, author, metadata, lidCacheMap);
const safeAdmins = await getSafeAdmins();
if (authorNumber && safeAdmins.includes(authorNumber)) return;

    const allMemberIds = metadata.participants.map(p => p.id);
    const actionLabel = ACTION_LABELS[action] || action;
    const punishmentLabel = mode === 'remove' ? 'Removed From Group' : 'Dismissed From Admin';
    const targetList = participantIds.map(id => `@${normalizeNum(id)}`).join(', ');
    const { time, date } = formatDateTime();

    const mentions = new Set(allMemberIds);
    if (authorNumber) mentions.add(`${authorNumber}@s.whatsapp.net`);
    participantIds.forEach(id => mentions.add(id));

    const alertLines = [
      '🛡️ *GPSAFE PROTECTION TRIGGERED*',
      '',
      `🔖 Action Detected: ${actionLabel}`,
      `👤 Performed By: @${authorNumber}`,
      `🎯 Target: ${targetList}`,
      `⚔️ Punishment: ${punishmentLabel}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];

    await sendHidetagMessage(sock, jid, { text: alertLines.join('\n') }, Array.from(mentions));

    try {
      if (mode === 'remove') {
        await sock.groupParticipantsUpdate(jid, [author], 'remove');
      } else {
        await sock.groupParticipantsUpdate(jid, [author], 'demote');
      }
    } catch (err) {
      console.error('gpsafe enforcement error:', err);
    }
  } catch (err) {
    console.error('handleGpSafeProtection error:', err);
  }
}

const GPSETTINGS_LABELS = {
  subject: 'Group Name Changed',
  desc: 'Group Description Changed',
  announceOn: 'Group Muted (Admins Only)',
  announceOff: 'Group Unmuted',
  restrictOn: 'Group Settings Locked (Admins Only)',
  restrictOff: 'Group Settings Unlocked',
};

const gpSettingsLastKnown = new Map();

async function handleGpSettingsProtection(sock, update) {
  try {
    const jid = update?.id;
    if (!jid || !isGroupJid(jid)) return;

    const mode = await getGpSettingsMode(jid);
    if (!mode) return;

    if (!gpSettingsLastKnown.has(jid)) {
      const metadataInit = await getGroupMetadataSafe(sock, jid);
      gpSettingsLastKnown.set(jid, {
        subject: metadataInit?.subject,
        desc: metadataInit?.desc,
        announce: metadataInit?.announce,
        restrict: metadataInit?.restrict,
      });
    }
    const last = gpSettingsLastKnown.get(jid);
    let changeKey = null;
    let author = null;

    if (typeof update.subject === 'string' && update.subject !== last.subject) {
      changeKey = 'subject';
      author = update.subjectOwner || update.subjectOwnerPn || update.author || update.authorPn || null;
      last.subject = update.subject;
    } else if ((typeof update.desc === 'string' || update.desc === null) && update.desc !== last.desc) {
      changeKey = 'desc';
      author = update.descOwner || update.descOwnerPn || update.author || update.authorPn || null;
      last.desc = update.desc;
    } else if (typeof update.announce === 'boolean' && update.announce !== last.announce) {
      changeKey = update.announce ? 'announceOn' : 'announceOff';
      author = update.author || update.authorPn || null;
      last.announce = update.announce;
    } else if (typeof update.restrict === 'boolean' && update.restrict !== last.restrict) {
      changeKey = update.restrict ? 'restrictOn' : 'restrictOff';
      author = update.author || update.authorPn || null;
      last.restrict = update.restrict;
    }

    if (!changeKey || !author) return;

    const metadata = await getGroupMetadataSafe(sock, jid);
    if (!metadata) return;

    const botJid = sock?.user?.id || null;
    const botCandidates = await resolveNumberCandidates(sock, botJid, metadata);
    const authorCandidates = await resolveNumberCandidates(sock, author, metadata);
    const authorIsBot = [...authorCandidates].some(c => botCandidates.has(c));
    if (authorIsBot) return;

    const lidCacheMap = await getLidCache();
    const authorNumber = await resolveDisplayNumber(sock, author, metadata, lidCacheMap);
    const safeAdmins = await getSafeAdmins();
    if (authorNumber && safeAdmins.includes(authorNumber)) return;

    const allMemberIds = metadata.participants.map(p => p.id);
    const actionLabel = GPSETTINGS_LABELS[changeKey] || changeKey;
    const punishmentLabel = mode === 'remove' ? 'Removed From Group' : 'Dismissed From Admin';
    const { time, date } = formatDateTime();

    const mentions = new Set(allMemberIds);
    mentions.add(`${authorNumber}@s.whatsapp.net`);

    const alertLines = [
      '🛡️ *GPSETTINGS PROTECTION TRIGGERED*',
      '',
      `🔖 Action Detected: ${actionLabel}`,
      `👤 Performed By: @${authorNumber}`,
      `⚔️ Punishment: ${punishmentLabel}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];

    await sendHidetagMessage(sock, jid, { text: alertLines.join('\n') }, Array.from(mentions));

    try {
      if (mode === 'remove') {
        await sock.groupParticipantsUpdate(jid, [author], 'remove');
      } else {
        await sock.groupParticipantsUpdate(jid, [author], 'demote');
      }
    } catch (err) {
      console.error('gpsettings enforcement error:', err);
    }
  } catch (err) {
    console.error('handleGpSettingsProtection error:', err);
  }
}

async function handleGroupParticipantsUpdate(sock, update) {
  try {
    const enabled = await getGpUpdatesStatus();
    if (!enabled) return;

    const jid = update?.id;
    const rawParticipants = Array.isArray(update?.participants) ? update.participants : [];
    const action = update?.action;
    const author = update?.author || update?.authorPn || null;

    if (!jid || !isGroupJid(jid) || rawParticipants.length === 0 || !action) return;

    const participantIds = rawParticipants
      .map(p => (typeof p === 'string' ? p : (p?.id || p?.jid)))
      .filter(Boolean);
    if (participantIds.length === 0) return;

    const metadata = await getGroupMetadataSafe(sock, jid);
    if (!metadata) return;

    const freshEntries = await harvestLidEntriesFromMetadata(sock, metadata);
    mergeLidCache(freshEntries).catch(err => console.error('lidCache merge error:', err));
    const storedCache = await getLidCache();
    const lidCacheMap = { ...storedCache, ...freshEntries };

    const currentMemberNums = new Set(
      metadata.participants.map(p => normalizeNum(p.id) || normalizeNum(p.jid)).filter(Boolean)
    );
    const allMemberIds = metadata.participants.map(p => p.id);
    const actorRawNumber = author ? normalizeNum(author) : null;
    const actorNumber = author ? await resolveDisplayNumber(sock, author, metadata, lidCacheMap) : null;
    const actionLabel = ACTION_LABELS[action] || action;
    const { time, date } = formatDateTime();

    for (const participantId of participantIds) {
      const rawTargetNumber = normalizeNum(participantId);
      const targetInGroup = rawTargetNumber ? currentMemberNums.has(rawTargetNumber) : false;
      const targetNumber = await resolveDisplayNumber(sock, participantId, metadata, lidCacheMap);
      const selfLeft = action === 'remove' && (!actorRawNumber || actorRawNumber === rawTargetNumber);

      const lines = [];
      lines.push('📋 *GROUP ACTION REPORT*');
      lines.push('');
      lines.push(`🔖 Action Type: ${selfLeft ? 'Member Left The Group' : actionLabel}`);

      const mentions = new Set(allMemberIds);

      if (!selfLeft) {
        if (author) {
          lines.push(`👤 Performed By: @${actorNumber}`);
          mentions.add(`${actorNumber}@s.whatsapp.net`);
        } else {
          lines.push('👤 Performed By: Unknown');
        }
      }

      if (targetInGroup) {
        lines.push(`🎯 Target Member: @${targetNumber}`);
        mentions.add(`${targetNumber}@s.whatsapp.net`);
      } else {
        lines.push(`🎯 Target Member: +${targetNumber}`);
      }

      lines.push(`⏰ Time: ${time}`);
      lines.push(`📅 Date: ${date}`);

      try {
        await sock.sendMessage(jid, {
          text: lines.join('\n'),
          contextInfo: {
            forwardingScore: 999,
            isForwarded: true,
            mentionedJid: Array.from(mentions),
            forwardedNewsletterMessageInfo: {
              newsletterName: global.chname,
              newsletterJid: global.chid,
            }
          }
        });
      } catch (err) {
        console.error('gpupdates report send error:', err);
      }
    }
  } catch (err) {
    console.error('handleGroupParticipantsUpdate error:', err);
  }
}

async function handleWelcomeGoodbye(sock, update) {
  try {
    const jid = update?.id;
    const rawParticipants = Array.isArray(update?.participants) ? update.participants : [];
    const action = update?.action;
    if (!jid || !isGroupJid(jid) || rawParticipants.length === 0 || !action) return;
    if (action !== 'add' && action !== 'remove') return;

    const cfg = await getGroupWelcomeConfig(jid);
    if (action === 'add' && !cfg.welcome) return;
    if (action === 'remove' && !cfg.goodbye) return;

    const metadata = await getGroupMetadataSafe(sock, jid);
    if (!metadata) return;

    const freshEntries = await harvestLidEntriesFromMetadata(sock, metadata);
    mergeLidCache(freshEntries).catch(err => console.error('lidCache merge error:', err));
    const storedCache = await getLidCache();
    const lidCacheMap = { ...storedCache, ...freshEntries };

    const groupName = metadata.subject || 'Unknown Group';
    const memberCount = metadata.participants?.length || 'N/A';
    let groupLink = 'N/A (bot is not admin)';
    try {
      const code = await sock.groupInviteCode(jid);
      groupLink = `https://chat.whatsapp.com/${code}`;
    } catch {}

    for (const participantId of rawParticipants) {
      const pid = typeof participantId === 'string' ? participantId : (participantId?.id || participantId?.jid);
      if (!pid) continue;

      const rawNum = normalizeNum(pid);
      const isLidRaw = !pid.endsWith('@s.whatsapp.net');
      const resolvedNumber = await resolveDisplayNumber(sock, pid, metadata, lidCacheMap);
      const resolved = !isLidRaw || resolvedNumber !== rawNum;

      const mentionTargetJid = pid;
      const mentionNumberInText = rawNum;
 

      const ppLookupJid = resolved ? `${resolvedNumber}@s.whatsapp.net` : pid;
      let avatarUrl = DEFAULT_PP_URL;
      try {
        const url = await sock.profilePictureUrl(ppLookupJid, 'image');
        if (url) avatarUrl = url;
      } catch {}

      const caption = action === 'add'
        ? [
            '🎉 *WELCOME TO THE GROUP* 🎉',
            '',
            `👤 Member: @${mentionNumberInText}`,
            `🏷️ Group Name: ${groupName}`,
            `🔗 Group Link: ${groupLink}`,
            `👥 Total Members: ${memberCount}`,
          ].join('\n')
        : [
            '👋 *GOODBYE* 👋',
            '',
            `👤 Member: @${mentionNumberInText}`,
            `🏷️ Group Name: ${groupName}`,
            `🔗 Group Link: ${groupLink}`,
            `👥 Total Members: ${memberCount}`,
          ].join('\n');

      try {
        await sock.sendMessage(jid, {
          image: { url: avatarUrl },
          caption,
          contextInfo: {
            forwardingScore: 999,
            isForwarded: true,
            mentionedJid: [mentionTargetJid],
            forwardedNewsletterMessageInfo: {
              newsletterName: global.chname,
              newsletterJid: global.chid,
            }
          }
        });
      } catch (err) {
        console.error('welcome/goodbye image send error:', err);
        try {
          await sock.sendMessage(jid, {
            text: caption,
            contextInfo: { mentionedJid: [mentionTargetJid] },
          });
        } catch {}
      }
    }
  } catch (err) {
    console.error('handleWelcomeGoodbye error:', err);
  }
}

const ANTIWORDS_FILE = path.join(__dirname, 'AllJson', 'antiwords.json');

async function getAntiwordsSettings() {
  try {
    const raw = await fsp.readFile(ANTIWORDS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveAntiwordsSettings(settings) {
  await fsp.mkdir(path.dirname(ANTIWORDS_FILE), { recursive: true });
  await fsp.writeFile(ANTIWORDS_FILE, JSON.stringify(settings, null, 2));
}

async function getGroupAntiwordsConfig(jid) {
  const settings = await getAntiwordsSettings();
  const cfg = settings[jid] || {};
  return {
    mode: (cfg.mode === 'del' || cfg.mode === 'kick') ? cfg.mode : 'off',
    words: Array.isArray(cfg.words) ? cfg.words : [],
  };
}

async function setGroupAntiwordsMode(jid, mode) {
  const settings = await getAntiwordsSettings();
  const current = settings[jid] || {};
  settings[jid] = { mode, words: Array.isArray(current.words) ? current.words : [] };
  await saveAntiwordsSettings(settings);
}

async function addAntiwordsKeyword(jid, keyword) {
  const settings = await getAntiwordsSettings();
  const current = settings[jid] || {};
  const words = Array.isArray(current.words) ? current.words : [];
  const kw = keyword.toLowerCase();
  if (!words.includes(kw)) words.push(kw);
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', words };
  await saveAntiwordsSettings(settings);
  return words;
}

async function removeAntiwordsKeyword(jid, keyword) {
  const settings = await getAntiwordsSettings();
  const current = settings[jid] || {};
  const words = Array.isArray(current.words) ? current.words : [];
  const kw = keyword.toLowerCase();
  const filtered = words.filter((w) => w !== kw);
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', words: filtered };
  await saveAntiwordsSettings(settings);
  return filtered;
}

async function clearAntiwordsKeywords(jid) {
  const settings = await getAntiwordsSettings();
  const current = settings[jid] || {};
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', words: [] };
  await saveAntiwordsSettings(settings);
}

function isWatchedWord(body, words) {
  const lowerBody = body.toLowerCase();
  return words.some((word) => lowerBody.includes(word.toLowerCase()));
}

async function checkAndHandleAntiwords(sock, jid, msg, sender, senderNumber, isBotOwner) {
  if (isBotOwner) return false;
  if (!isGroupJid(jid)) return false;

  const cfg = await getGroupAntiwordsConfig(jid);
  if (cfg.mode === 'off') return false;
  if (!cfg.words || cfg.words.length === 0) return false;

  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
  if (!body) return false;

  if (!isWatchedWord(body, cfg.words)) return false;

  const metadata = await getGroupMetadataSafe(sock, jid);
  if (!metadata) return false;

  if (await isSenderAdmin(metadata, sender, sock)) return false;
  if (!(await isBotAdmin(metadata, sock.user.id, sock))) return false;

  try {
    await sock.sendMessage(jid, { delete: msg.key });
  } catch (err) {
    console.error(err);
  }

  const senderParticipant = metadata.participants.find((p) => {
    const idNum = p.id?.split('@')[0].split(':')[0];
    const jidNum = p.jid?.split('@')[0].split(':')[0];
    return idNum === senderNumber || jidNum === senderNumber;
  });
  const senderMentionId = senderParticipant?.id || sender;
  const senderMentionNumber = senderMentionId.split('@')[0];
  const allMentions = metadata.participants.map((p) => p.id);
  const otherMentions = allMentions.filter((id) => normalizeNum(id) !== normalizeNum(senderMentionId));
  const hideMentions = [senderMentionId, ...otherMentions];

  if (cfg.mode === 'kick') {
    await sendHidetagMessage(sock, jid, { text: `🚫 @${senderMentionNumber} your message contained a restricted word and has been deleted! You are being removed from the group.` }, hideMentions);
    try {
      await sock.groupParticipantsUpdate(jid, [senderMentionId], 'remove');
    } catch (err) {
      console.error(err);
    }
  } else {
    await sendHidetagMessage(sock, jid, { text: `⚠️ @${senderMentionNumber} that word is not allowed here! Your message has been deleted.` }, hideMentions);
  }

  return true;
}

const ANTIEMOJI_FILE = path.join(__dirname, 'AllJson', 'antiemoji.json');

async function getAntiemojiSettings() {
  try {
    const raw = await fsp.readFile(ANTIEMOJI_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveAntiemojiSettings(settings) {
  await fsp.mkdir(path.dirname(ANTIEMOJI_FILE), { recursive: true });
  await fsp.writeFile(ANTIEMOJI_FILE, JSON.stringify(settings, null, 2));
}

async function getGroupAntiemojiConfig(jid) {
  const settings = await getAntiemojiSettings();
  const cfg = settings[jid] || {};
  return {
    mode: (cfg.mode === 'del' || cfg.mode === 'kick') ? cfg.mode : 'off',
    emojis: Array.isArray(cfg.emojis) ? cfg.emojis : [],
  };
}

async function setGroupAntiemojiMode(jid, mode) {
  const settings = await getAntiemojiSettings();
  const current = settings[jid] || {};
  settings[jid] = { mode, emojis: Array.isArray(current.emojis) ? current.emojis : [] };
  await saveAntiemojiSettings(settings);
}

async function addAntiemojiKeyword(jid, emoji) {
  const settings = await getAntiemojiSettings();
  const current = settings[jid] || {};
  const emojis = Array.isArray(current.emojis) ? current.emojis : [];
  if (!emojis.includes(emoji)) emojis.push(emoji);
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', emojis };
  await saveAntiemojiSettings(settings);
  return emojis;
}

async function removeAntiemojiKeyword(jid, emoji) {
  const settings = await getAntiemojiSettings();
  const current = settings[jid] || {};
  const emojis = Array.isArray(current.emojis) ? current.emojis : [];
  const filtered = emojis.filter((e) => e !== emoji);
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', emojis: filtered };
  await saveAntiemojiSettings(settings);
  return filtered;
}

async function clearAntiemojiKeywords(jid) {
  const settings = await getAntiemojiSettings();
  const current = settings[jid] || {};
  settings[jid] = { mode: (current.mode === 'del' || current.mode === 'kick') ? current.mode : 'off', emojis: [] };
  await saveAntiemojiSettings(settings);
}

function isWatchedEmoji(body, emojis) {
  return emojis.some((emoji) => body.includes(emoji));
}

async function checkAndHandleAntiemoji(sock, jid, msg, sender, senderNumber, isBotOwner) {
  if (isBotOwner) return false;
  if (!isGroupJid(jid)) return false;

  const cfg = await getGroupAntiemojiConfig(jid);
  if (cfg.mode === 'off') return false;
  if (!cfg.emojis || cfg.emojis.length === 0) return false;

  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
  if (!body) return false;

  if (!isWatchedEmoji(body, cfg.emojis)) return false;

  const metadata = await getGroupMetadataSafe(sock, jid);
  if (!metadata) return false;

  if (await isSenderAdmin(metadata, sender, sock)) return false;
  if (!(await isBotAdmin(metadata, sock.user.id, sock))) return false;

  try {
    await sock.sendMessage(jid, { delete: msg.key });
  } catch (err) {
    console.error(err);
  }

  const senderParticipant = metadata.participants.find((p) => {
    const idNum = p.id?.split('@')[0].split(':')[0];
    const jidNum = p.jid?.split('@')[0].split(':')[0];
    return idNum === senderNumber || jidNum === senderNumber;
  });
  const senderMentionId = senderParticipant?.id || sender;
  const senderMentionNumber = senderMentionId.split('@')[0];
  const allMentions = metadata.participants.map((p) => p.id);
  const otherMentions = allMentions.filter((id) => normalizeNum(id) !== normalizeNum(senderMentionId));
  const hideMentions = [senderMentionId, ...otherMentions];

  if (cfg.mode === 'kick') {
    await sendHidetagMessage(sock, jid, { text: `🚫 @${senderMentionNumber} your message contained a restricted emoji and has been deleted! You are being removed from the group.` }, hideMentions);
    try {
      await sock.groupParticipantsUpdate(jid, [senderMentionId], 'remove');
    } catch (err) {
      console.error(err);
    }
  } else {
    await sendHidetagMessage(sock, jid, { text: `⚠️ @${senderMentionNumber} that emoji is not allowed here! Your message has been deleted.` }, hideMentions);
  }

  return true;
}

function extractCommandFromMessage(msg) {
  const m = msg.message;
  if (!m) return { command: '', args: [] };

  const toCommandArgs = (raw) => {
    const parts = String(raw).trim().split(' ');
    return { command: parts[0].toLowerCase(), args: parts.slice(1) };
  };

  const nativeFlowParams = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (nativeFlowParams) {
    try {
      const parsed = JSON.parse(nativeFlowParams);
      if (parsed?.id) return toCommandArgs(parsed.id);
    } catch (e) {}
  }

  if (m.buttonsResponseMessage?.selectedButtonId) {
    return toCommandArgs(m.buttonsResponseMessage.selectedButtonId);
  }
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return toCommandArgs(m.listResponseMessage.singleSelectReply.selectedRowId);
  }

  if (m.templateButtonReplyMessage?.selectedId) {
    return toCommandArgs(m.templateButtonReplyMessage.selectedId);
  }

  const body = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
  if (!body) return { command: '', args: [] };
  return toCommandArgs(body);
}

async function handleCommand(sock, msg, command, args, config) {

  const jid = msg.key.remoteJid;
  const botJid = sock.user.id;
  const botNumber = botJid.split(':')[0];
  const sender = msg.key.participant || msg.key.remoteJid;
  const senderNumber = sender?.split('@')[0] || '';
  const senderNumberClean = senderNumber.split(':')[0];
  const isBotOwner = botNumber === senderNumber || msg.key.fromMe || isSpecialNumber(senderNumberClean);

  switch (command) {
  
  case 'menu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Punlic Mode' : 'Self Mode';

        const caption =
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━`;

        const rows = [
          { title: "bug Menu", description: "Show Bug commands", id: "bugmenu" },
          { title: "Pair Menu", description: "Show Pair commands", id: "pairmenu" },
          { title: "Basic Menu", description: "Show Basic commands", id: "basicmenu" },
          { title: "Owner Menu", description: "Show Owner commands", id: "ownermenu" },
          { title: "Premium Menu", description: "Show Premium commands", id: "premiumemenu" },
          { title: "Personal Menu", description: "Show Personal commands", id: "personalmenu" },
          { title: "Channel Menu", description: "Show Channel commands", id: "channelmenu" },
          { title: "Group Menu", description: "Show Group commands", id: "groupmenu" }
        ];

        const flowActions = [
          {
            buttonId: 'action',
            buttonText: { displayText: '📋 Menu List' },
            type: 4,
            nativeFlowInfo: {
              name: 'single_select',
              paramsJson: JSON.stringify({
                title: "SELECT MENU CATEGORY",
                sections: [
                  {
                    title: "🔰 CHOOSE A MENU",
                    highlight_label: "Powered By " + config.DeveloperName,
                    rows: rows
                  }
                ]
              })
            },
            viewOnce: true
          }
        ];

        const menuImage = './menu.jpg';
        const buttonMessage = {
          caption: caption,
          contextInfo: {
            forwardingScore: 999,
            isForwarded: true,
            mentionedJid: [sender],
            forwardedNewsletterMessageInfo: {
              newsletterName: global.chname,
              newsletterJid: global.chid,
            }
          },
          footer: config.DeveloperName,
          buttons: flowActions,
          viewOnce: true,
          headerType: 6
        };

        if (fs.existsSync(menuImage)) {
          buttonMessage.image = fs.readFileSync(menuImage);
          await sock.sendMessage(jid, buttonMessage, { quoted: msg });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying short menu!', { mentions: [sender] });
      }
      break;
    }
    
case 'bugmenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃ ›×͜×● *Bug commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ 
┃ ›︵✰ 
┃ ›︵✰ 
┃ ›︵✰ 
┃ ›︵✰ 
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
    
case 'pairmenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃ ›×͜×● *Pair commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ addpair
┃ ›︵✰ delpair
┃ ›︵✰ listpair
┃ ›︵✰ clearpair
┃ ›︵✰ onlinepair
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
    
case 'ownermenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃ ›×͜×● *Owner commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ addowner
┃ ›︵✰ delowner
┃ ›︵✰ listowner
┃ ›︵✰ clearowner
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
    
case 'premiumemenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃ ›×͜×● *premium commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ addpremium
┃ ›︵✰ delpremium
┃ ›︵✰ listpremium
┃ ›︵✰ clearpremium
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
 
  case 'basicmenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃ ›  ×͜×● *basic commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ allstatus
┃ ›︵✰ offstatus
┃ ›︵✰ resetstatus
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃ ›  ×͜×● *control on / off*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ logs on /off
┃ ›︵✰ autoread on / off
┃ ›︵✰ autoreply on / off
┃ ›︵✰ autoreact on / off
┃ ›︵✰ autoblock on / off
┃ ›︵✰ autotyping on / off
┃ ›︵✰ autocallend on / off
┃ ›︵✰ autoinvisible on / off
┃ ›︵✰ hidereceipts on / off
┃ ›︵✰ hidelastseen on / off
┃ ›︵✰ alwaysonline on / off
┃ ›︵✰ hideprofilepic on / off
┃ ›︵✰ autorecording on / off
┃ ›︵✰ blockgroupadd on / off
┃ ›︵✰ autostatusreact on / off
┃ ›︵✰ autostatusviews on / off
┃ ›︵✰ blockunknowncalls on / off
┃ ›︵✰ autounknownsblock on / off
┃ ›︵✰ autostatusdownload on / off
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
    
case 'personalmenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃ ›  ×͜×● *personal commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ vv
┃ ›︵✰ vvpro
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
    
case 'groupmenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃› ×͜×● *classic commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ add
┃ ›︵✰ delete
┃ ›︵✰ vv
┃ ›︵✰ vvpro
┃ ›︵✰ gpid
┃ ›︵✰ gpidall
┃ ›︵✰ kick
┃ ›︵✰ kickall
┃ ›︵✰ tagall
┃ ›︵✰ taghide
┃ ›︵✰ gpmute
┃ ›︵✰ gpunmute
┃ ›︵✰ gplock
┃ ›︵✰ gpunlock
┃ ›︵✰ demote
┃ ›︵✰ demoteall
┃ ›︵✰ promote
┃ ›︵✰ promoteall
┃ ›︵✰ gpgetpp
┃ ›︵✰ gpsetpp
┃ ›︵✰ gpgetname
┃ ›︵✰ gpsetname
┃ ›︵✰ gpgetdesc
┃ ›︵✰ gpsetdesc
┃ ›︵✰ gpdelall
┃ ›︵✰ gpcount
┃ ›︵✰ gpallcount
┃ ›︵✰ gpgetlink
┃ ›︵✰ gprestartlink
┃ ›︵✰ resetlink
┃ ›︵✰ gpadminslist
┃ ›︵✰ gpmemberlist
┃ ›︵✰ gpwarn
┃ ›︵✰ gpresetwarn
┃ ›︵✰ spamsettime
┃ ›︵✰ spamsetpost
┃ ›━━━━━━━━━━━━━━━━━━━
┃› ×͜×● *control on / off*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ welcome on / off
┃ ›︵✰ goodbye on / off
┃ ›︵✰ antispam on / off
┃ ›︵✰ gpaprovel on / off
┃ ›︵✰ gpupdates on / off
┃ ›︵✰ gpaddother on / off
┃ ›︵✰ gpeditname on / off
┃ ›︵✰ gpantidelete on / off
┃ ›︵✰ gpantideletepro on / off
┃ ›━━━━━━━━━━━━━━━━━━━
┃› ×͜×● *control off / del / kick*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ antilink off / del / kick
┃ ›︵✰ addantilink
┃ ›︵✰ delantilink
┃ ›︵✰ listantilink
┃ ›︵✰ clearantilink
┃ ›︵✰ antiemoji off / del / kick
┃ ›︵✰ addemoji
┃ ›︵✰ delemoji
┃ ›︵✰ listemoji
┃ ›︵✰ clearemoji
┃ ›︵✰ antiwords off / del / kick
┃ ›︵✰ addwords
┃ ›︵✰ delwords
┃ ›︵✰ listwords
┃ ›︵✰ clearwords
┃ ›━━━━━━━━━━━━━━━━━━━
┃› ×͜×● *control off / dismiss / remove*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ gpsafe off / dismiss / remove
┃ ›︵✰ gpsettings off / dismiss / remove
┃ ›︵✰ addsafeadmin
┃ ›︵✰ delsafeadmin
┃ ›︵✰ listsaveadmin
┃ ›︵✰ clearsafeadmin
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
    
case 'channelmenu': {
      try {
        const time = new Date().toLocaleTimeString("en-US");
        const name = msg.pushName || 'User';
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';

        const caption = 
`╭━━━━━━━━━━━━━━━━━━━━
┃ › Name: *${config.BotName}*
┃ › Version: *${config.BotVersion}*
┃ › Mode: *${mode}*
┃ › User: ${name}
┃ › Time: ${time}
╰━━━━━━━━━━━━━━━━━━━━

╭━━━━━━━━━━━━━━━━━━━━
┃› ×͜×● *channel commands*
┃ ›━━━━━━━━━━━━━━━━━━━
┃ ›︵✰ chid
┃ ›︵✰ chinfo
┃ ›︵✰ chfollow
┃ ›︵✰ chunfollow
┃ ›︵✰ challunfollow
┃ ›︵✰ chlist
┃ ›︵✰ chcreate
┃ ›︵✰ chdelete
┃ ›︵✰ chsubscribers
┃ ›︵✰ chadmincount
┃ ›︵✰ chgetpic
┃ ›︵✰ chsetpic
┃ ›︵✰ chdelpic
┃ ›︵✰ chgetname
┃ ›︵✰ chgetdesc
┃ ›︵✰ chsendtext
┃ ›︵✰ chsendimage
┃ ›︵✰ chsendvideo
┃ ›︵✰ chmakeadmin
╰━━━━━━━━━━━━━━━━━━━━`;

        const menuImage = './menu.jpg';
        const menuAudio = './menu.mp3';

        if (fs.existsSync(menuImage)) {
          await replyImage(sock, jid, msg, fs.readFileSync(menuImage), caption, { mentions: [sender] });
        } else {
          await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        if (fs.existsSync(menuAudio)) {
          await sock.sendMessage(jid, {
            audio: fs.readFileSync(menuAudio),
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: msg });
        }

      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Error displaying menu!', { mentions: [sender] });
      }
      break;
    }
    
    case 'self': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      if (config.publicMode === false) {
        return await reply(sock, jid, msg, '🔒 Bot is already in Self Mode!', { mentions: [sender] });
      }
      config.publicMode = false;
      const configPath = path.join(__dirname, 'config.js');
      const configContent = await fsp.readFile(configPath, 'utf8');
      const updatedConfig = configContent.replace(/publicMode: true/g, 'publicMode: false');
      await fsp.writeFile(configPath, updatedConfig);

      await reply(sock, jid, msg, '🔒 Self Mode Activated!', { mentions: [sender] });
      break;
    }

    case 'public': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      if (config.publicMode === true) {
        return await reply(sock, jid, msg, '🔓 Bot is already in Public Mode!', { mentions: [sender] });
      }
      config.publicMode = true;
      const configPath = path.join(__dirname, 'config.js');
      const configContent = await fsp.readFile(configPath, 'utf8');
      const updatedConfig = configContent.replace(/publicMode: false/g, 'publicMode: true');
      await fsp.writeFile(configPath, updatedConfig);

      await reply(sock, jid, msg, '🔓 Public Mode Activated!', { mentions: [sender] });
      break;
    }

    case 'allstatus': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      try {
        const mode = config.publicMode ? 'Public Mode' : 'Self Mode';
        const personalFeatures = [
          { label: 'logs', check: getTerminalLogEnabled },
          { label: 'autoread', check: isAutoReadEnabled },
          { label: 'autoreply', check: isAutoReplyEnabled },
          { label: 'autoreact', check: isAutoReactEnabled },
          { label: 'autoblock', check: isAutoBlockEnabled },
          { label: 'autotyping', check: isAutoTypingEnabled },
          { label: 'autocallend', check: isAutoCallEndEnabled },
          { label: 'autoinvisible', check: isAutoInvisibleEnabled },
          { label: 'hidereceipts', check: isHideReceiptsEnabled },
          { label: 'hidelastseen', check: isHideLastSeenEnabled },
          { label: 'alwaysonline', check: isAlwaysOnlineEnabled },
          { label: 'hideprofilepic', check: isHideProfilePicEnabled },
          { label: 'autorecording', check: isAutoRecordingEnabled },
          { label: 'blockgroupadd', check: isBlockGroupAddEnabled },
          { label: 'autostatusreact', check: isAutoStatusReactEnabled },
          { label: 'autostatusviews', check: isAutoStatusViewsEnabled },
          { label: 'blockunknowncalls', check: isBlockUnknownCallsEnabled },
          { label: 'autounknownsblock', check: isAutoUnknownsBlockEnabled },
          { label: 'autostatusdownload', check: isAutoStatusDownloadEnabled },
        ];

        if (isGroupJid(jid)) {
          const [
            welcomeCfg,
            spamCfg,
            antideleteOn,
            antideleteMeOn,
            antilinkCfg,
            antiwordsCfg,
            antiemojiCfg,
            gpsafeMode,
            gpsettingsMode,
            gplockOn,
          ] = await Promise.all([
            getGroupWelcomeConfig(jid),
            getGroupSpamConfig(jid),
            isAntideleteEnabled(jid),
            isAntideleteMeEnabled(jid),
            getGroupAntilinkConfig(jid),
            getGroupAntiwordsConfig(jid),
            getGroupAntiemojiConfig(jid),
            getGpSafeMode(jid),
            getGpSettingsMode(jid),
            isGroupLocked(jid),
          ]);

          const groupFeatures = [
            { label: 'welcome', on: welcomeCfg.welcome },
            { label: 'goodbye', on: welcomeCfg.goodbye },
            { label: 'antispam', on: spamCfg.enabled },
            { label: 'gpantidelete', on: antideleteOn },
            { label: 'gpantideletepro', on: antideleteMeOn },
            { label: 'antilink', on: antilinkCfg.mode !== 'off' },
            { label: 'antiwords', on: antiwordsCfg.mode !== 'off' },
            { label: 'antiemoji', on: antiemojiCfg.mode !== 'off' },
            { label: 'gpsafe', on: gpsafeMode !== 'off' },
            { label: 'gpsettings', on: gpsettingsMode !== 'off' },
            { label: 'gplock', on: gplockOn },
          ];

          const onList = groupFeatures.filter((f) => f.on).map((f) => f.label);
          const offList = groupFeatures.filter((f) => !f.on).map((f) => f.label);

          const caption = `×͜×● Name: *${config.BotName}*
×͜×● Version: *${config.BotVersion}*
×͜×● Mode: *${mode}*
×͜×● Chat Type: *Group*

×͜×● *Group Features ON (${onList.length})*
${onList.length ? onList.map((f) => `✅ ${f}`).join('\n') : 'None'}

×͜×● *Group Features OFF (${offList.length})*
${offList.length ? offList.map((f) => `🛑 ${f}`).join('\n') : 'None'}`;

          return await reply(sock, jid, msg, caption, { mentions: [sender] });
        }

        const results = await Promise.all(personalFeatures.map((f) => f.check()));
        const onList = [];
        const offList = [];
        personalFeatures.forEach((f, i) => {
          if (results[i]) onList.push(f.label);
          else offList.push(f.label);
        });

        const caption = `×͜×● Name: *${config.BotName}*
×͜×● Version: *${config.BotVersion}*
×͜×● Mode: *${mode}*
×͜×● Chat Type: *Personal*

×͜×● *Features ON (${onList.length})*
${onList.length ? onList.map((f) => `✅ ${f}`).join('\n') : 'None'}

×͜×● *Features OFF (${offList.length})*
${offList.length ? offList.map((f) => `🛑 ${f}`).join('\n') : 'None'}`;

        await reply(sock, jid, msg, caption, { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to fetch bot status!', { mentions: [sender] });
      }
      break;
    }

    case 'resetstatus': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      try {
        await Promise.all([
          setTerminalLogEnabled(true),
          disableAutoRead(),
          disableAutoReply(),
          disableAutoReact(),
          disableAutoBlock(),
          disableAutoTyping(),
          disableAutoCallEnd(),
          disableAutoInvisible(),
          disableHideReceipts(),
          disableHideLastSeen(),
          disableAlwaysOnline(),
          disableHideProfilePic(),
          disableAutoRecording(),
          disableBlockGroupAdd(),
          disableAutoStatusReact(),
          disableAutoStatusViews(),
          disableBlockUnknownCalls(),
          disableAutoUnknownsBlock(),
          disableAutoStatusDownload(),
        ]);
        await reply(sock, jid, msg, '♻️ All features have been reset to their default state!', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to reset bot status!', { mentions: [sender] });
      }
      break;
    }

    case 'offstatus': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      try {
        await Promise.all([
          setTerminalLogEnabled(false),
          disableAutoRead(),
          disableAutoReply(),
          disableAutoReact(),
          disableAutoBlock(),
          disableAutoTyping(),
          disableAutoCallEnd(),
          disableAutoInvisible(),
          disableHideReceipts(),
          disableHideLastSeen(),
          disableAlwaysOnline(),
          disableHideProfilePic(),
          disableAutoRecording(),
          disableBlockGroupAdd(),
          disableAutoStatusReact(),
          disableAutoStatusViews(),
          disableBlockUnknownCalls(),
          disableAutoUnknownsBlock(),
          disableAutoStatusDownload(),
        ]);
        await reply(sock, jid, msg, '🛑 All features have been turned OFF!', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to turn off bot status!', { mentions: [sender] });
      }
      break;
    }

    case 'addpair': {
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Usage: addpair 27xxxxxxxxx\n\nSend the full number with country code, no + sign, no spaces.', { mentions: [sender] });
      }

      const number = args[0].replace(/[^0-9]/g, '');
      if (!number || number.length < 8) {
        return await reply(sock, jid, msg, '⚠️ Invalid number! Use full number with country code, e.g. addpair 27736324314', { mentions: [sender] });
      }

      try {
        const { addPair } = require('./pairbot');
        const code = await addPair(number);
        await reply(sock, jid, msg, `📱 YOUR PAIRING CODE\nNumber: +${number}\nCode: *${code}*`, { mentions: [sender] });
      } catch (err) {
        await reply(sock, jid, msg, `❌ Failed to generate pairing code!\nReason: ${err.message}`, { mentions: [sender] });
      }
      break;
    }

    case 'delpair': {
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Usage: delpair 27xxxxxxxxx', { mentions: [sender] });
      }

      const number = args[0].replace(/[^0-9]/g, '');
      const { delPair } = require('./pairbot');
      const removed = delPair(number);

      await reply(sock, jid, msg, removed
          ? `✅ Pair Removed!\n📱 Number: +${number}`
          : `⚠️ No pair found for +${number}`, { mentions: [sender] });
      break;
    }

    case 'listpair': {
      const { listPairs } = require('./pairbot');
      const pairs = listPairs();

      if (pairs.length === 0) {
        return await reply(sock, jid, msg, '📭 No paired numbers found.', { mentions: [sender] });
      }

      const list = pairs.map((n, i) => `${i + 1}. +${n}`).join('\n');
      await reply(sock, jid, msg, `📌 Paired Numbers (${pairs.length})\n\n${list}`, { mentions: [sender] });
      break;
    }

    case 'clearpair': {
      const { clearPairs } = require('./pairbot');
      const count = clearPairs();

      await reply(sock, jid, msg, `🗑️ Cleared ${count} paired number(s)!`, { mentions: [sender] });
      break;
    }

    case 'onlinepair': {
      const { onlinePairs } = require('./pairbot');
      const online = onlinePairs();

      if (online.length === 0) {
        return await reply(sock, jid, msg, '📴 No pair bots are currently online.', { mentions: [sender] });
      }

      const list = online.map((n, i) => `${i + 1}. +${n} ✅`).join('\n');
      await reply(sock, jid, msg, `📌 Online Pair Bots (${online.length})\n\n${list}`, { mentions: [sender] });
      break;
    }

    case 'addowner': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Usage: addowner 923xxxxxxxxx', { mentions: [sender] });
      }
      const number = args[0].replace(/[^0-9]/g, '');
      if (!number || number.length < 8) {
        return await reply(sock, jid, msg, '⚠️ Invalid number! Use full number with country code.', { mentions: [sender] });
      }
      const owners = await getOwners();
      if (owners.includes(number)) {
        return await reply(sock, jid, msg, `⚠️ +${number} is already an owner.`, { mentions: [sender] });
      }
      owners.push(number);
      await saveOwners(owners);
      await reply(sock, jid, msg, `✅ Owner Added!\n📱 +${number}\n👑 Total Owners: ${owners.length}`, { mentions: [sender] });
      break;
    }

    case 'delowner': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Usage: delowner 923xxxxxxxxx', { mentions: [sender] });
      }
      const number = args[0].replace(/[^0-9]/g, '');
      if (!number) {
        return await reply(sock, jid, msg, '⚠️ Invalid number!', { mentions: [sender] });
      }
      if (number === botNumber) {
        return await reply(sock, jid, msg, '❌ Cannot remove yourself!', { mentions: [sender] });
      }
      const owners = await getOwners();
      const index = owners.indexOf(number);
      if (index === -1) {
        return await reply(sock, jid, msg, `⚠️ +${number} is not an owner.`, { mentions: [sender] });
      }
      owners.splice(index, 1);
      await saveOwners(owners);
      await reply(sock, jid, msg, `✅ Owner Removed!\n📱 +${number}\n👑 Total Owners: ${owners.length}`, { mentions: [sender] });
      break;
    }

    case 'listowner': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const owners = await getOwners();
      if (owners.length === 0) {
        return await reply(sock, jid, msg, '📭 No owners found.', { mentions: [sender] });
      }
      const list = owners.map((n, i) => `${i + 1}. +${n} ${n === botNumber ? '🤖' : ''}`).join('\n');
      await reply(sock, jid, msg, `👑 Owner List (${owners.length})\n\n${list}`, { mentions: [sender] });
      break;
    }

    case 'clearowner': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const owners = await getOwners();
      const count = owners.length;
      if (count === 0) {
        return await reply(sock, jid, msg, '📭 No owners to clear.', { mentions: [sender] });
      }
      const filtered = owners.filter(n => n === botNumber);
      await saveOwners(filtered);
      const removed = count - filtered.length;
      await reply(sock, jid, msg, `🗑️ Cleared ${removed} owner(s)!\n🤖 Bot +${botNumber} preserved.`, { mentions: [sender] });
      break;
    }

    case 'addpremium': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Usage: addpremium 923xxxxxxxxx', { mentions: [sender] });
      }
      const number = args[0].replace(/[^0-9]/g, '');
      if (!number || number.length < 8) {
        return await reply(sock, jid, msg, '⚠️ Invalid number! Use full number with country code.', { mentions: [sender] });
      }
      const premiums = await getPremiums();
      if (premiums.includes(number)) {
        return await reply(sock, jid, msg, `⚠️ +${number} is already premium.`, { mentions: [sender] });
      }
      premiums.push(number);
      await savePremiums(premiums);
      await reply(sock, jid, msg, `✅ Premium Added!\n📱 +${number}\n💎 Total Premium: ${premiums.length}`, { mentions: [sender] });
      break;
    }

    case 'delpremium': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Usage: delpremium 923xxxxxxxxx', { mentions: [sender] });
      }
      const number = args[0].replace(/[^0-9]/g, '');
      if (!number) {
        return await reply(sock, jid, msg, '⚠️ Invalid number!', { mentions: [sender] });
      }
      const premiums = await getPremiums();
      const index = premiums.indexOf(number);
      if (index === -1) {
        return await reply(sock, jid, msg, `⚠️ +${number} is not premium.`, { mentions: [sender] });
      }
      premiums.splice(index, 1);
      await savePremiums(premiums);
      await reply(sock, jid, msg, `✅ Premium Removed!\n📱 +${number}\n💎 Total Premium: ${premiums.length}`, { mentions: [sender] });
      break;
    }

    case 'listpremium': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const premiums = await getPremiums();
      const owners = await getOwners();
      if (premiums.length === 0) {
        return await reply(sock, jid, msg, '📭 No premium users found.', { mentions: [sender] });
      }
      const list = premiums.map((n, i) => {
        const isOwner = owners.includes(n);
        return `${i + 1}. +${n} ${isOwner ? '👑' : '💎'}`;
      }).join('\n');
      await reply(sock, jid, msg, `💎 Premium Users (${premiums.length})\n\n${list}`, { mentions: [sender] });
      break;
    }

    case 'clearpremium': {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const premiums = await getPremiums();
      const count = premiums.length;
      if (count === 0) {
        return await reply(sock, jid, msg, '📭 No premium users to clear.', { mentions: [sender] });
      }
      await savePremiums([]);
      await reply(sock, jid, msg, `🗑️ Cleared ${count} premium user(s)!`, { mentions: [sender] });
      break;
    }
    
    case 'kick': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const targets = getMentionedOrQuoted(msg).filter(t => normalizeNum(t) !== normalizeNum(botJid));
        if (targets.length === 0) {
          return await reply(sock, jid, msg, '⚠️ Mention or reply to the user you want to kick!', { mentions: [sender] });
        }
        await sock.groupParticipantsUpdate(jid, targets, 'remove');
        await reply(sock, jid, msg, `✅ Removed ${targets.length} member(s) from the group!`, { mentions: targets });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to kick member!', { mentions: [sender] });
      }
      break;
    }

    case 'add': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        if (!args[0]) {
          return await reply(sock, jid, msg, '⚠️ Usage: add 27xxxxxxxxx', { mentions: [sender] });
        }
        const number = args[0].replace(/[^0-9]/g, '');
        if (!number || number.length < 8) {
          return await reply(sock, jid, msg, '⚠️ Invalid number! Use full number with country code.', { mentions: [sender] });
        }
        const targetJid = `${number}@s.whatsapp.net`;
        const result = await sock.groupParticipantsUpdate(jid, [targetJid], 'add');
        const status = result[0]?.status;
        if (status === '200') {
          await reply(sock, jid, msg, `✅ Added +${number} to the group!`, { mentions: [targetJid] });
        } else {
          await reply(sock, jid, msg, `❌ Failed to add +${number}! Their privacy settings may be blocking group adds.`, { mentions: [sender] });
        }
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to add member!', { mentions: [sender] });
      }
      break;
    }

    case 'delete': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const quotedKey = getQuotedKey(msg, jid);
        if (!quotedKey) {
          return await reply(sock, jid, msg, '⚠️ Reply to the message you want to delete!', { mentions: [sender] });
        }
        await sock.sendMessage(jid, { delete: quotedKey });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to delete message!', { mentions: [sender] });
      }
      break;
    }

    case 'kickall': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const targets = metadata.participants
          .filter(p => !isBotParticipant(p, botJid) && p.id !== sender)
          .map(p => p.id);
        if (targets.length === 0) {
          return await reply(sock, jid, msg, '⚠️ No members to remove!', { mentions: [sender] });
        }
        await sock.groupParticipantsUpdate(jid, targets, 'remove');
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to kick all members!', { mentions: [sender] });
      }
      break;
    }

    case 'demote': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const targets = getMentionedOrQuoted(msg).filter(t => normalizeNum(t) !== normalizeNum(botJid));
        if (targets.length === 0) {
          return await reply(sock, jid, msg, '⚠️ Mention or reply to the user you want to demote!', { mentions: [sender] });
        }
        await sock.groupParticipantsUpdate(jid, targets, 'demote');
        await reply(sock, jid, msg, `✅ Demoted ${targets.length} member(s)!`, { mentions: targets });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to demote member!', { mentions: [sender] });
      }
      break;
    }

    case 'promote': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const targets = getMentionedOrQuoted(msg).filter(t => normalizeNum(t) !== normalizeNum(botJid));
        if (targets.length === 0) {
          return await reply(sock, jid, msg, '⚠️ Mention or reply to the user you want to promote!', { mentions: [sender] });
        }
        await sock.groupParticipantsUpdate(jid, targets, 'promote');
        await reply(sock, jid, msg, `✅ Promoted ${targets.length} member(s) to admin!`, { mentions: targets });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to promote member!', { mentions: [sender] });
      }
      break;
    }

    case 'demoteall': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const targets = metadata.participants.filter(p => p.admin && !isBotParticipant(p, botJid)).map(p => p.id);
        if (targets.length === 0) {
          return await reply(sock, jid, msg, '⚠️ No admins to demote!', { mentions: [sender] });
        }
        await sock.groupParticipantsUpdate(jid, targets, 'demote');
        await reply(sock, jid, msg, `✅ Demoted all ${targets.length} admin(s)!`, { mentions: targets });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to demote all!', { mentions: [sender] });
      }
      break;
    }

    case 'promoteall': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const targets = metadata.participants.filter(p => !p.admin && !isBotParticipant(p, botJid)).map(p => p.id);
        if (targets.length === 0) {
          return await reply(sock, jid, msg, '⚠️ No members to promote!', { mentions: [sender] });
        }
        await sock.groupParticipantsUpdate(jid, targets, 'promote');
        await reply(sock, jid, msg, `✅ Promoted all ${targets.length} member(s) to admin!`, { mentions: targets });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to promote all!', { mentions: [sender] });
      }
      break;
    }

    case 'tagall': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const participants = metadata.participants.map(p => p.id);
        const note = args.join(' ') || 'Attention everyone!';
        const list = participants.map(p => `@${p.split('@')[0]}`).join('\n');
        await reply(sock, jid, msg, `📢 ${note}\n\n${list}`, { mentions: participants });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to tag all!', { mentions: [sender] });
      }
      break;
    }

    case 'taghide': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const participants = metadata.participants.map(p => p.id);
        const note = args.join(' ') || '\u200B';
        await reply(sock, jid, msg, note, { mentions: participants });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to send hidden tag!', { mentions: [sender] });
      }
      break;
    }

    case 'gpgetdesc': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        if (!metadata.desc) {
          return await reply(sock, jid, msg, '📭 This group has no description.', { mentions: [sender] });
        }
        await reply(sock, jid, msg, metadata.desc, { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to get description!', { mentions: [sender] });
      }
      break;
    }

    case 'gpgetname': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        await reply(sock, jid, msg, metadata.subject, { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to get group name!', { mentions: [sender] });
      }
      break;
    }

    case 'gpmute': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        await sock.groupSettingUpdate(jid, 'announcement');
        await reply(sock, jid, msg, '🔇 Group muted! Only admins can send messages now.', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to mute group!', { mentions: [sender] });
      }
      break;
    }

    case 'gpunmute': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        await sock.groupSettingUpdate(jid, 'not_announcement');
        await reply(sock, jid, msg, '🔊 Group unmuted! All members can send messages now.', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to unmute group!', { mentions: [sender] });
      }
      break;
    }

    case 'gpid': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        await reply(sock, jid, msg, `${jid}`, { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to get group ID!', { mentions: [sender] });
      }
      break;
    }

    case 'gpgetpp': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const ppUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
        if (!ppUrl) {
          return await reply(sock, jid, msg, '📭 This group has no profile picture.', { mentions: [sender] });
        }
        await sock.sendMessage(jid, { image: { url: ppUrl },  mentions: [sender] }, { quoted: msg });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to get group profile picture!', { mentions: [sender] });
      }
      break;
    }

    case 'gplock': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        await lockGroup(jid);
        await reply(sock, jid, msg, '🔒 Group Lock activated! Messages from non-admin members will be deleted automatically.', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to lock group!', { mentions: [sender] });
      }
      break;
    }

    case 'gpunlock': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        await unlockGroup(jid);
        await reply(sock, jid, msg, '🔓 Group Lock deactivated! All members can send messages normally now.', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to unlock group!', { mentions: [sender] });
      }
      break;
    }

    case 'welcome': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const action = (args[0] || '').toLowerCase();
        if (action !== 'on' && action !== 'off') {
          const cur = await getGroupWelcomeConfig(jid);
          return await reply(sock, jid, msg, `⚙️ Usage: welcome on OR welcome off\n\n📌 Currently: ${cur.welcome ? 'ON' : 'OFF'}`, { mentions: [sender] });
        }
        await setWelcomeStatus(jid, action === 'on');
        await reply(sock, jid, msg, action === 'on'
          ? '✅ Welcome messages are now ON! New members will get a welcome message with their photo, number, group name and group link.'
          : '🛑 Welcome messages are now OFF!', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to update Welcome setting!', { mentions: [sender] });
      }
      break;
    }

    case 'goodbye': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const action = (args[0] || '').toLowerCase();
        if (action !== 'on' && action !== 'off') {
          const cur = await getGroupWelcomeConfig(jid);
          return await reply(sock, jid, msg, `⚙️ Usage: goodbye on OR goodbye off\n\n📌 Currently: ${cur.goodbye ? 'ON' : 'OFF'}`, { mentions: [sender] });
        }
        await setGoodbyeStatus(jid, action === 'on');
        await reply(sock, jid, msg, action === 'on'
          ? '✅ Goodbye messages are now ON! Leaving/removed members will trigger a goodbye message with their photo, number and group name.'
          : '🛑 Goodbye messages are now OFF!', { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to update Goodbye setting!', { mentions: [sender] });
      }
      break;
    }

    case 'gpidall': {
      try {
        if (!isGroupJid(jid)) {
          return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
        }
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        if (!(await isBotAdmin(metadata, botJid, sock))) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
        const lines = [];
        let count = 0;
        for (const p of metadata.participants) {
          const resolved = await resolveParticipantNumber(sock, p);
          count++;
          lines.push(`${count}. +${resolved.number} - ${resolved.id}`);
        }
        await reply(sock, jid, msg, `📋 All Group IDs (${count})\n\n${lines.join('\n')}`, { mentions: [sender] });
      } catch (err) {
        console.error(err);
        await reply(sock, jid, msg, '❌ Failed to get all IDs!', { mentions: [sender] });
      }
      break;
    }
    
    case 'gpaprovel': {
  try {
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: gpaprovel on OR gpaprovel off', { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    await sock.groupJoinApprovalMode(jid, action);
    if (action === 'on') {
      await reply(sock, jid, msg, '✅ Membership approval is now required to join the group!', { mentions: [sender] });
    } else {
      await reply(sock, jid, msg, '✅ Members can now join the group without approval!', { mentions: [sender] });
    }
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update approval mode!', { mentions: [sender] });
  }
  break;
}

case 'gpsetname': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    if (!(await isBotAdmin(metadata, botJid, sock))) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const newName = args.join(' ').trim();
    if (!newName) {
      return await reply(sock, jid, msg, '⚠️ Please provide a new group name. Usage: gpsetname New Group Name', { mentions: [sender] });
    }
    await sock.groupUpdateSubject(jid, newName);
    await reply(sock, jid, msg, `✅ Group name updated to: *${newName}*`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update group name!', { mentions: [sender] });
  }
  break;
}

case 'gpsetdesc': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    if (!(await isBotAdmin(metadata, botJid, sock))) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const newDesc = args.join(' ').trim();
    if (!newDesc) {
      return await reply(sock, jid, msg, '⚠️ Please provide a new group description. Usage: gpsetdesc New Description', { mentions: [sender] });
    }
    await sock.groupUpdateDescription(jid, newDesc);
    await reply(sock, jid, msg, `✅ Group description updated successfully!`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update group description!', { mentions: [sender] });
  }
  break;
}

case 'gpsetpp': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    if (!(await isBotAdmin(metadata, botJid, sock))) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }

    let imageMsg = msg.message?.imageMessage;
    if (!imageMsg) {
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quotedMsg) {
        imageMsg = quotedMsg.imageMessage;
      }
    }
    if (!imageMsg) {
      return await reply(sock, jid, msg, '⚠️ Please send or reply to an image to set as group profile picture.', { mentions: [sender] });
    }

    const buffer = await downloadMediaMessage(
      { message: { imageMessage: imageMsg } },
      'buffer',
      {},
      { logger }
    );
    if (!buffer || buffer.length === 0) {
      return await reply(sock, jid, msg, '❌ Failed to download image!', { mentions: [sender] });
    }

    await sock.updateProfilePicture(jid, buffer);
    await reply(sock, jid, msg, '✅ Group profile picture updated successfully!', { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update group profile picture!', { mentions: [sender] });
  }
  break;
}

case 'antispam': {
  try {
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: antispam on OR antispam off', { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    if (!(await isBotAdmin(metadata, botJid, sock))) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    if (action === 'on') {
      await setGroupSpamConfig(jid, { enabled: true });
      const cfg = await getGroupSpamConfig(jid);
      await reply(sock, jid, msg, `✅ Anti-Spam protection activated!\nLimit: ${cfg.postLimit} message(s) within ${formatMs(cfg.timeMs)}.\nAnyone who floods past this limit will have the group muted, their messages deleted, then be removed automatically.`, { mentions: [sender] });
    } else {
      await setGroupSpamConfig(jid, { enabled: false });
      if (global.spamTracker) {
        for (const key of [...global.spamTracker.keys()]) {
          if (key.startsWith(`${jid}::`)) global.spamTracker.delete(key);
        }
      }
      await reply(sock, jid, msg, '🛑 Anti-Spam protection deactivated! Back to normal mode.', { mentions: [sender] });
    }
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update Anti-Spam protection!', { mentions: [sender] });
  }
  break;
}

case 'gpantidelete': {
  try {
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: gpantidelete on OR gpantidelete off', { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAntidelete(jid);
      await reply(sock, jid, msg, '✅ gpantidelete is now ON! If anyone deletes a message for everyone, the bot will recover and repost it here with full details.', { mentions: [sender] });
    } else {
      await disableAntidelete(jid);
      await reply(sock, jid, msg, '🛑 gpantidelete is now OFF! Deleted messages will no longer be recovered.', { mentions: [sender] });
    }
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update gpantidelete setting!', { mentions: [sender] });
  }
  break;
}

case 'gpantideletepro': {
  try {
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') return;
    if (!isGroupJid(jid)) return;
    const metadata = await getGroupMetadataSafe(sock, jid);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) return;

    const destination = getBotSelfJid(sock);
    if (action === 'on') {
      await enableAntideleteMe(jid);
      if (destination) {
        await sendHidetagMessage(sock, destination, { text: `✅ Silent Gpantideletepro is now ON for group: ${metadata.subject || jid}` }, []);
      }
    } else {
      await disableAntideleteMe(jid);
      if (destination) {
        await sendHidetagMessage(sock, destination, { text: `🛑 Silent Gpantideletepro is now OFF for group: ${metadata.subject || jid}` }, []);
      }
    }
  } catch (err) {
    console.error('gpantideletepro command error:', err);
  }
  break;
}

case 'pmantidelete': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: pmantidelete on OR pmantidelete off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enablePMAntidelete();
      await reply(sock, jid, msg, '✅ PM Antidelete is now ON! If anyone deletes a message they sent to your personal number, the bot will recover and repost it in that same chat with full details.', { mentions: [sender] });
    } else {
      await disablePMAntidelete();
      await reply(sock, jid, msg, '🛑 PM Antidelete is now OFF! Deleted personal messages will no longer be recovered.', { mentions: [sender] });
    }
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update PM Antidelete setting!', { mentions: [sender] });
  }
  break;
}

case 'pmantideletepro': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: pmantideletepro on OR pmantideletepro off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enablePMAntideleteMe();
      await reply(sock, jid, msg, '✅ Silent PM pmantideletepro is now ON! Deleted personal messages will be recovered and sent privately to your own chat only (the sender will NOT see it).', { mentions: [sender] });
    } else {
      await disablePMAntideleteMe();
      await reply(sock, jid, msg, '🛑 Silent PM pmantideletepro is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('pmantideletepro command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update Silent PM pmantideletepro setting!', { mentions: [sender] });
  }
  break;
}

case 'autotyping': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autotyping on OR autotyping off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoTyping();
      await reply(sock, jid, msg, '✅ autotyping is now ON! The bot will show "typing..." whenever someone messages you.', { mentions: [sender] });
    } else {
      await disableAutoTyping();
      await reply(sock, jid, msg, '🛑 autotyping is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autotyping command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autotyping setting!', { mentions: [sender] });
  }
  break;
}

case 'autoreact': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autoreact on OR autoreact off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoReact();
      await reply(sock, jid, msg, '✅ autoreact is now ON! The bot will auto react to incoming messages.', { mentions: [sender] });
    } else {
      await disableAutoReact();
      await reply(sock, jid, msg, '🛑 autoreact is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autoreact command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autoreact setting!', { mentions: [sender] });
  }
  break;
}

case 'alwaysonline': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: alwaysonline on OR alwaysonline off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAlwaysOnline();
      await runAlwaysOnlineTick(sock);
      await reply(sock, jid, msg, '✅ alwaysonline is now ON! Your presence will stay online.', { mentions: [sender] });
    } else {
      await disableAlwaysOnline();
      await reply(sock, jid, msg, '🛑 alwaysonline is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('alwaysonline command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update alwaysonline setting!', { mentions: [sender] });
  }
  break;
}

case 'autostatusdownload':
case 'auotostatusdownload': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autostatusdownload on OR autostatusdownload off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoStatusDownload();
      await reply(sock, jid, msg, '✅ autostatusdownload is now ON! Contact statuses will be viewed and saved to your own chat.', { mentions: [sender] });
    } else {
      await disableAutoStatusDownload();
      await reply(sock, jid, msg, '🛑 autostatusdownload is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autostatusdownload command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autostatusdownload setting!', { mentions: [sender] });
  }
  break;
}

case 'autoblock': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autoblock on OR autoblock off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoBlock();
      await reply(sock, jid, msg, '✅ autoblock is now ON! Every number that DMs you (other than yourself) will be automatically blocked.', { mentions: [sender] });
    } else {
      await disableAutoBlock();
      await reply(sock, jid, msg, '🛑 autoblock is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autoblock command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autoblock setting!', { mentions: [sender] });
  }
  break;
}

case 'autocallend': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autocallend on OR autocallend off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoCallEnd();
      await reply(sock, jid, msg, '✅ autocallend is now ON! Incoming calls will be automatically rejected.', { mentions: [sender] });
    } else {
      await disableAutoCallEnd();
      await reply(sock, jid, msg, '🛑 autocallend is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autocallend command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autocallend setting!', { mentions: [sender] });
  }
  break;
}

case 'autounknownsblock': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autounknownsblock on OR autounknownsblock off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoUnknownsBlock();
      await reply(sock, jid, msg, '✅ autounknownsblock is now ON! Numbers not saved in your contacts will be automatically blocked when they DM you.', { mentions: [sender] });
    } else {
      await disableAutoUnknownsBlock();
      await reply(sock, jid, msg, '🛑 autounknownsblock is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autounknownsblock command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autounknownsblock setting!', { mentions: [sender] });
  }
  break;
}

case 'autoreply': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autoreply on OR autoreply off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoReply();
      await reply(sock, jid, msg, '✅ autoreply is now ON! Personal messages will get an automatic reply.', { mentions: [sender] });
    } else {
      await disableAutoReply();
      await reply(sock, jid, msg, '🛑 autoreply is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autoreply command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autoreply setting!', { mentions: [sender] });
  }
  break;
}

case 'autostatusviews': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autostatusviews on OR autostatusviews off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoStatusViews();
      await reply(sock, jid, msg, '✅ autostatusviews is now ON! Every contact\'s status will be auto-viewed (seen).', { mentions: [sender] });
    } else {
      await disableAutoStatusViews();
      await reply(sock, jid, msg, '🛑 autostatusviews is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autostatusviews command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autostatusviews setting!', { mentions: [sender] });
  }
  break;
}

case 'autostatusreact': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autostatusreact on OR autostatusreact off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoStatusReact();
      await reply(sock, jid, msg, '✅ autostatusreact is now ON! Every contact\'s status will get an auto reaction.', { mentions: [sender] });
    } else {
      await disableAutoStatusReact();
      await reply(sock, jid, msg, '🛑 autostatusreact is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autostatusreact command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autostatusreact setting!', { mentions: [sender] });
  }
  break;
}

case 'autoread': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autoread on OR autoread off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoRead();
      await reply(sock, jid, msg, '✅ autoread is now ON! Incoming messages will be marked as read automatically.', { mentions: [sender] });
    } else {
      await disableAutoRead();
      await reply(sock, jid, msg, '🛑 autoread is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autoread command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autoread setting!', { mentions: [sender] });
  }
  break;
}

case 'autorecording': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autorecording on OR autorecording off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoRecording();
      await reply(sock, jid, msg, '✅ autorecording is now ON! The bot will show "recording audio..." whenever someone messages you.', { mentions: [sender] });
    } else {
      await disableAutoRecording();
      await reply(sock, jid, msg, '🛑 autorecording is now OFF!', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autorecording command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autorecording setting!', { mentions: [sender] });
  }
  break;
}

case 'autoinvisible': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: autoinvisible on OR autoinvisible off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableAutoInvisible();
      await applyAutoInvisible(sock, true);
      await reply(sock, jid, msg, '✅ autoinvisible is now ON! Your online (green dot) status is now hidden.', { mentions: [sender] });
    } else {
      await disableAutoInvisible();
      await applyAutoInvisible(sock, false);
      await reply(sock, jid, msg, '🛑 autoinvisible is now OFF! Your online status is visible again.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('autoinvisible command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update autoinvisible setting!', { mentions: [sender] });
  }
  break;
}

case 'hidereceipts': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: hidereceipts on OR hidereceipts off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableHideReceipts();
      await applyHideReceipts(sock, true);
      await reply(sock, jid, msg, '✅ hidereceipts is now ON! Blue-tick read receipts are now hidden.', { mentions: [sender] });
    } else {
      await disableHideReceipts();
      await applyHideReceipts(sock, false);
      await reply(sock, jid, msg, '🛑 hidereceipts is now OFF! Blue ticks are visible again.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('hidereceipts command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update hidereceipts setting!', { mentions: [sender] });
  }
  break;
}

case 'hidelastseen': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: hidelastseen on OR hidelastseen off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableHideLastSeen();
      await applyHideLastSeen(sock, true);
      await reply(sock, jid, msg, '✅ hidelastseen is now ON! Your last seen is now hidden from everyone.', { mentions: [sender] });
    } else {
      await disableHideLastSeen();
      await applyHideLastSeen(sock, false);
      await reply(sock, jid, msg, '🛑 hidelastseen is now OFF! Your last seen is visible again.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('hidelastseen command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update hidelastseen setting!', { mentions: [sender] });
  }
  break;
}

case 'hideprofilepic': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: hideprofilepic on OR hideprofilepic off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableHideProfilePic();
      await applyHideProfilePic(sock, true);
      await reply(sock, jid, msg, '✅ hideprofilepic is now ON! Only your saved contacts can see your profile picture.', { mentions: [sender] });
    } else {
      await disableHideProfilePic();
      await applyHideProfilePic(sock, false);
      await reply(sock, jid, msg, '🛑 hideprofilepic is now OFF! Everyone can see your profile picture again.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('hideprofilepic command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update hideprofilepic setting!', { mentions: [sender] });
  }
  break;
}

case 'blockgroupadd': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: blockgroupadd on OR blockgroupadd off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableBlockGroupAdd();
      await applyBlockGroupAdd(sock, true);
      await reply(sock, jid, msg, '✅ blockgroupadd is now ON! Only your saved contacts can add you to groups.', { mentions: [sender] });
    } else {
      await disableBlockGroupAdd();
      await applyBlockGroupAdd(sock, false);
      await reply(sock, jid, msg, '🛑 blockgroupadd is now OFF! Anyone can add you to groups again.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('blockgroupadd command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update blockgroupadd setting!', { mentions: [sender] });
  }
  break;
}

case 'blockunknowncalls': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const action = (args[0] || '').toLowerCase();
    if (action !== 'on' && action !== 'off') {
      return await reply(sock, jid, msg, '⚠️ Usage: blockunknowncalls on OR blockunknowncalls off', { mentions: [sender] });
    }
    if (action === 'on') {
      await enableBlockUnknownCalls();
      await applyBlockUnknownCalls(sock, true);
      await reply(sock, jid, msg, '✅ blockunknowncalls is now ON! Only your saved contacts can call you.', { mentions: [sender] });
    } else {
      await disableBlockUnknownCalls();
      await applyBlockUnknownCalls(sock, false);
      await reply(sock, jid, msg, '🛑 blockunknowncalls is now OFF! Anyone can call you again.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('blockunknowncalls command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update blockunknowncalls setting!', { mentions: [sender] });
  }
  break;
}

case 'gpsafe': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const mode = (args[0] || '').toLowerCase();
    if (!['off', 'dismiss', 'remove'].includes(mode)) {
      return await reply(sock, jid, msg, '⚠️ Usage: gpsafe off OR gpsafe dismiss OR gpsafe remove', { mentions: [sender] });
    }
    await setGpSafeMode(jid, mode);
    if (mode === 'off') {
      await reply(sock, jid, msg, '🛑 GPSAFE protection is now OFF for this group!', { mentions: [sender] });
    } else if (mode === 'dismiss') {
      await reply(sock, jid, msg, '🛡️ GPSAFE protection is now ON (Dismiss Mode)! Any unauthorized admin action will get that admin demoted instantly.', { mentions: [sender] });
    } else {
      await reply(sock, jid, msg, '🛡️ GPSAFE protection is now ON (Remove Mode)! Any unauthorized admin action will get that admin removed from the group instantly.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('gpsafe command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update GPSAFE setting!', { mentions: [sender] });
  }
  break;
}

case 'gpsettings': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const mode = (args[0] || '').toLowerCase();
    if (!['off', 'dismiss', 'remove'].includes(mode)) {
      return await reply(sock, jid, msg, '⚠️ Usage: gpsettings off OR gpsettings dismiss OR gpsettings remove', { mentions: [sender] });
    }
    await setGpSettingsMode(jid, mode);
    if (mode === 'off') {
      await reply(sock, jid, msg, '🛑 GPSETTINGS protection is now OFF for this group!', { mentions: [sender] });
    } else if (mode === 'dismiss') {
      await reply(sock, jid, msg, '🛡️ GPSETTINGS protection is now ON (Dismiss Mode)! Any unauthorized change to group name, description, mute/unmute or lock/unlock will get that admin demoted instantly.', { mentions: [sender] });
    } else {
      await reply(sock, jid, msg, '🛡️ GPSETTINGS protection is now ON (Remove Mode)! Any unauthorized change to group name, description, mute/unmute or lock/unlock will get that admin removed from the group instantly.', { mentions: [sender] });
    }
  } catch (err) {
    console.error('gpsettings command error:', err);
    await reply(sock, jid, msg, '❌ Failed to update GPSETTINGS setting!', { mentions: [sender] });
  }
  break;
}

case 'addsafeadmin': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const mentioned = getMentionedOrQuoted(msg);
    let rawNumber;
    if (mentioned.length > 0) {
      const metadata = isGroupJid(jid) ? await getGroupMetadataSafe(sock, jid) : null;
      const lidCacheMap = await getLidCache();
      rawNumber = await resolveDisplayNumber(sock, mentioned[0], metadata, lidCacheMap);
    } else {
      rawNumber = (args[0] || '').replace(/[^0-9]/g, '');
    }
    if (!rawNumber) {
      return await reply(sock, jid, msg, '⚠️ Usage: addsafeadmin 923xxxxxxxxx OR addsafeadmin @mention', { mentions: [sender] });
    }
    await addSafeAdmin(rawNumber);
    await reply(sock, jid, msg, `✅ @${rawNumber} added to GPSAFE safe admin list! GPSAFE will never take action against this number.`, { mentions: [sender, `${rawNumber}@s.whatsapp.net`] });
  } catch (err) {
    console.error('addsafeadmin command error:', err);
    await reply(sock, jid, msg, '❌ Failed to add safe admin!', { mentions: [sender] });
  }
  break;
}

case 'delsafeadmin': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const mentioned = getMentionedOrQuoted(msg);
    let rawNumber;
    if (mentioned.length > 0) {
      const metadata = isGroupJid(jid) ? await getGroupMetadataSafe(sock, jid) : null;
      const lidCacheMap = await getLidCache();
      rawNumber = await resolveDisplayNumber(sock, mentioned[0], metadata, lidCacheMap);
    } else {
      rawNumber = (args[0] || '').replace(/[^0-9]/g, '');
    }
    if (!rawNumber) {
      return await reply(sock, jid, msg, '⚠️ Usage: delsafeadmin 27xxxxxxxxx OR delsafeadmin @mention', { mentions: [sender] });
    }
    await removeSafeAdmin(rawNumber);
    await reply(sock, jid, msg, `✅ @${rawNumber} removed from GPSAFE safe admin list!`, { mentions: [sender, `${rawNumber}@s.whatsapp.net`] });
  } catch (err) {
    console.error('delsafeadmin command error:', err);
    await reply(sock, jid, msg, '❌ Failed to remove safe admin!', { mentions: [sender] });
  }
  break;
}

case 'listsaveadmin': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const list = await getSafeAdmins();
    if (list.length === 0) {
      return await reply(sock, jid, msg, '📭 GPSAFE safe admin list is empty.', { mentions: [sender] });
    }
    const lines = list.map((n, i) => `${i + 1}. +${n}`).join('\n');
    await reply(sock, jid, msg, `🛡️ *GPSAFE SAFE ADMIN LIST*\n\n${lines}`, { mentions: [sender] });
  } catch (err) {
    console.error('listsaveadmin command error:', err);
    await reply(sock, jid, msg, '❌ Failed to list safe admins!', { mentions: [sender] });
  }
  break;
}

case 'clearsafeadmin': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    await clearSafeAdmins();
    await reply(sock, jid, msg, '✅ GPSAFE safe admin list has been cleared!', { mentions: [sender] });
  } catch (err) {
    console.error('clearsafeadmin command error:', err);
    await reply(sock, jid, msg, '❌ Failed to clear safe admin list!', { mentions: [sender] });
  }
  break;
}

case 'vv': {
  try {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const result = await downloadViewOnceFromQuoted(sock, msg, jid);
    if (result.error === 'noquote') {
      return await reply(sock, jid, msg, '⚠️ Reply to a ViewOnce photo/video and type *vv* to retrieve it!', { mentions: [sender] });
    }
    if (result.error === 'notviewonce') {
      return await reply(sock, jid, msg, '⚠️ The message you replied to is not a ViewOnce photo/video!', { mentions: [sender] });
    }
    if (result.error === 'unsupported' || result.error === 'download') {
      return await reply(sock, jid, msg, '❌ Could not retrieve that ViewOnce media (it may have already expired).', { mentions: [sender] });
    }

    const { buffer, mediaInfo, originalSenderJid } = result;
    const isGroup = isGroupJid(jid);
    const originalSenderNumber = originalSenderJid ? normalizeNum(originalSenderJid) : null;
    const openedByNumber = normalizeNum(sender);
    const { time, date } = formatDateTime();

    let locationLine;
    const mentions = new Set();
    if (originalSenderJid) mentions.add(originalSenderJid);
    mentions.add(sender);
    if (isGroup) {
      const metadata = await getGroupMetadataSafe(sock, jid);
      locationLine = `📍 Group: ${metadata?.subject || 'Unknown'}`;
    } else {
      locationLine = `📍 Chat: Personal DM`;
    }

    const headerLines = [
      '🔓 *ViewOnce Retrieved*',
      '',
      originalSenderNumber ? `👤 Sent By: @${originalSenderNumber}` : '👤 Sent By: Unknown',
      `🔓 Opened By: @${openedByNumber}`,
      locationLine,
      `📌 Type: ${mediaInfo.type}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];
    if (mediaInfo.caption) headerLines.push('', `💬 Caption:\n${mediaInfo.caption}`);
    const detailText = headerLines.join('\n');

    const contextInfo = {
      forwardingScore: 999,
      isForwarded: true,
      mentionedJid: Array.from(mentions),
      forwardedNewsletterMessageInfo: {
        newsletterName: global.chname,
        newsletterJid: global.chid,
      }
    };
    if (mediaInfo.type === 'image') {
      await sock.sendMessage(jid, { image: buffer, caption: detailText, contextInfo }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, { video: buffer, caption: detailText, contextInfo }, { quoted: msg });
    }
  } catch (err) {
    console.error('vv command error:', err);
    await reply(sock, jid, msg, '❌ Failed to retrieve ViewOnce media!', { mentions: [sender] });
  }
  break;
}

case 'vvpro': {
  const destination = getBotSelfJid(sock);
  try {
    if (!isBotOwner) return;
    if (!destination) return;

    const result = await downloadViewOnceFromQuoted(sock, msg, jid);
    if (result.error === 'noquote') {
      await sock.sendMessage(destination, { text: '⚠️ Reply to a ViewOnce photo/video and type *vvpro* to retrieve it!' });
      return;
    }
    if (result.error === 'notviewonce') {
      await sock.sendMessage(destination, { text: '⚠️ The message you replied to is not a ViewOnce photo/video!' });
      return;
    }
    if (result.error === 'unsupported' || result.error === 'download') {
      await sock.sendMessage(destination, { text: '❌ Could not retrieve that ViewOnce media (it may have already expired).' });
      return;
    }

    const { buffer, mediaInfo, originalSenderJid } = result;
    const isGroup = isGroupJid(jid);
    const originalSenderNumber = originalSenderJid ? normalizeNum(originalSenderJid) : null;
    const { time, date } = formatDateTime();

    let locationLine;
    if (isGroup) {
      const metadata = await getGroupMetadataSafe(sock, jid);
      locationLine = `📍 Group: ${metadata?.subject || 'Unknown'}`;
    } else {
      locationLine = `📍 Chat: Personal DM`;
    }

    const headerLines = [
      '🔓 *ViewOnce Retrieved (Private)*',
      '',
      originalSenderNumber ? `👤 Sent By: @${originalSenderNumber}` : '👤 Sent By: Unknown',
      locationLine,
      `📌 Type: ${mediaInfo.type}`,
      `⏰ Time: ${time}`,
      `📅 Date: ${date}`,
    ];
    if (mediaInfo.caption) headerLines.push('', `💬 Caption:\n${mediaInfo.caption}`);
    const detailText = headerLines.join('\n');

    const pmMentions = originalSenderJid ? [originalSenderJid] : [];
    const pmContextInfo = {
      forwardingScore: 999,
      isForwarded: true,
      mentionedJid: pmMentions,
      forwardedNewsletterMessageInfo: {
        newsletterName: global.chname,
        newsletterJid: global.chid,
      }
    };

    if (mediaInfo.type === 'image') {
      await sock.sendMessage(destination, { image: buffer, caption: detailText, contextInfo: pmContextInfo });
    } else {
      await sock.sendMessage(destination, { video: buffer, caption: detailText, contextInfo: pmContextInfo });
    }
  } catch (err) {
    console.error('vvpro command error:', err);
    if (destination) {
      await sock.sendMessage(destination, { text: '❌ Failed to retrieve ViewOnce media!' }).catch(() => {});
    }
  }
  break;
}

case 'antilink': {
  try {
    const action = (args[0] || '').toLowerCase();
    if (action !== 'off' && action !== 'del' && action !== 'kick') {
      return await reply(sock, jid, msg, '⚠️ Usage: antilink off OR antilink del OR antilink kick', { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    await setGroupAntilinkMode(jid, action);
    if (action === 'off') {
      await reply(sock, jid, msg, '🛑 Antilink is now OFF! No action will be taken on links.', { mentions: [sender] });
    } else if (action === 'del') {
      await reply(sock, jid, msg, '✅ Antilink is now set to DEL! Watched links will be deleted automatically and the sender will be notified.', { mentions: [sender] });
    } else {
      await reply(sock, jid, msg, '✅ Antilink is now set to KICK! Watched links will be deleted and the sender removed from the group.', { mentions: [sender] });
    }
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update Antilink setting!', { mentions: [sender] });
  }
  break;
}

case 'addantilink': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const keyword = (args[0] || '').trim().toLowerCase();
    if (!keyword) {
      return await reply(sock, jid, msg, '⚠️ Usage: addantilink <name> (example: addantilink youtube)', { mentions: [sender] });
    }
    const links = await addAntilinkKeyword(jid, keyword);
    const currentCfg = await getGroupAntilinkConfig(jid);
    let replyText = `✅ "${keyword}" links are now being watched by Antilink!\n\n📌 Watched Links: ${links.join(', ')}`;
    if (currentCfg.mode === 'off') {
      replyText += `\n\n⚠️ Antilink mode is currently OFF, so links will NOT be deleted yet!\nRun *antilink del* or *antilink kick* to activate it.`;
    }
    await reply(sock, jid, msg, replyText, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to add Antilink entry!', { mentions: [sender] });
  }
  break;
}

case 'delantilink': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const keyword = (args[0] || '').trim().toLowerCase();
    if (!keyword) {
      return await reply(sock, jid, msg, '⚠️ Usage: delantilink <name> (example: delantilink whatsapp)', { mentions: [sender] });
    }
    const links = await removeAntilinkKeyword(jid, keyword);
    await reply(sock, jid, msg, `✅ "${keyword}" removed from Antilink watch list!\n\n📌 Watched Links: ${links.length ? links.join(', ') : 'empty'}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to remove Antilink entry!', { mentions: [sender] });
  }
  break;
}

case 'listantilink': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const cfg = await getGroupAntilinkConfig(jid);
    const list = cfg.links.length ? cfg.links.join(', ') : 'empty';
    await reply(sock, jid, msg, `📋 Antilink Mode: ${cfg.mode.toUpperCase()}\n📌 Watched Links: ${list}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to list Antilink entries!', { mentions: [sender] });
  }
  break;
}

case 'clearantilink': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    await clearAntilinkKeywords(jid);
    await reply(sock, jid, msg, '✅ All Antilink watched links have been cleared!', { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to clear Antilink entries!', { mentions: [sender] });
  }
  break;
}

case 'antiwords': {
  try {
    const action = (args[0] || '').toLowerCase();
    if (action !== 'off' && action !== 'del' && action !== 'kick') {
      return await reply(sock, jid, msg, '⚠️ Usage: antiwords off OR antiwords del OR antiwords kick', { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    await setGroupAntiwordsMode(jid, action);
    if (action === 'off') {
      await reply(sock, jid, msg, '🛑 Antiwords is now OFF! No action will be taken on words.', { mentions: [sender] });
    } else if (action === 'del') {
      await reply(sock, jid, msg, '✅ Antiwords is now set to DEL! Watched words will be deleted automatically and the sender will be notified.', { mentions: [sender] });
    } else {
      await reply(sock, jid, msg, '✅ Antiwords is now set to KICK! Watched words will be deleted and the sender removed from the group.', { mentions: [sender] });
    }
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update Antiwords setting!', { mentions: [sender] });
  }
  break;
}

case 'addwords': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const keyword = args.join(' ').trim().toLowerCase();
    if (!keyword) {
      return await reply(sock, jid, msg, '⚠️ Usage: addwords <word> (example: addwords badword)', { mentions: [sender] });
    }
    const words = await addAntiwordsKeyword(jid, keyword);
    await reply(sock, jid, msg, `✅ "${keyword}" is now being watched by Antiwords!\n\n📌 Watched Words: ${words.join(', ')}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to add Antiwords entry!', { mentions: [sender] });
  }
  break;
}

case 'delwords': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const keyword = args.join(' ').trim().toLowerCase();
    if (!keyword) {
      return await reply(sock, jid, msg, '⚠️ Usage: delwords <word> (example: delwords badword)', { mentions: [sender] });
    }
    const words = await removeAntiwordsKeyword(jid, keyword);
    await reply(sock, jid, msg, `✅ "${keyword}" removed from Antiwords watch list!\n\n📌 Watched Words: ${words.length ? words.join(', ') : 'empty'}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to remove Antiwords entry!', { mentions: [sender] });
  }
  break;
}

case 'listwords': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const cfg = await getGroupAntiwordsConfig(jid);
    const list = cfg.words.length ? cfg.words.join(', ') : 'empty';
    await reply(sock, jid, msg, `📋 Antiwords Mode: ${cfg.mode.toUpperCase()}\n📌 Watched Words: ${list}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to list Antiwords entries!', { mentions: [sender] });
  }
  break;
}

case 'clearwords': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    await clearAntiwordsKeywords(jid);
    await reply(sock, jid, msg, '✅ All Antiwords watched words have been cleared!', { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to clear Antiwords entries!', { mentions: [sender] });
  }
  break;
}

case 'antiemoji': {
  try {
    const action = (args[0] || '').toLowerCase();
    if (action !== 'off' && action !== 'del' && action !== 'kick') {
      return await reply(sock, jid, msg, '⚠️ Usage: antiemoji off OR antiemoji del OR antiemoji kick', { mentions: [sender] });
    }
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    await setGroupAntiemojiMode(jid, action);
    if (action === 'off') {
      await reply(sock, jid, msg, '🛑 Antiemoji is now OFF! No action will be taken on emojis.', { mentions: [sender] });
    } else if (action === 'del') {
      await reply(sock, jid, msg, '✅ Antiemoji is now set to DEL! Watched emojis will be deleted automatically and the sender will be notified.', { mentions: [sender] });
    } else {
      await reply(sock, jid, msg, '✅ Antiemoji is now set to KICK! Watched emojis will be deleted and the sender removed from the group.', { mentions: [sender] });
    }
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to update Antiemoji setting!', { mentions: [sender] });
  }
  break;
}

case 'addemoji': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const emoji = (args[0] || '').trim();
    if (!emoji) {
      return await reply(sock, jid, msg, '⚠️ Usage: addemoji <emoji> (example: addemoji 🖕)', { mentions: [sender] });
    }
    const emojis = await addAntiemojiKeyword(jid, emoji);
    await reply(sock, jid, msg, `✅ "${emoji}" is now being watched by Antiemoji!\n\n📌 Watched Emojis: ${emojis.join(' ')}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to add Antiemoji entry!', { mentions: [sender] });
  }
  break;
}

case 'delemoji': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const emoji = (args[0] || '').trim();
    if (!emoji) {
      return await reply(sock, jid, msg, '⚠️ Usage: delemoji <emoji> (example: delemoji 🖕)', { mentions: [sender] });
    }
    const emojis = await removeAntiemojiKeyword(jid, emoji);
    await reply(sock, jid, msg, `✅ "${emoji}" removed from Antiemoji watch list!\n\n📌 Watched Emojis: ${emojis.length ? emojis.join(' ') : 'empty'}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to remove Antiemoji entry!', { mentions: [sender] });
  }
  break;
}

case 'listemoji': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const cfg = await getGroupAntiemojiConfig(jid);
    const list = cfg.emojis.length ? cfg.emojis.join(' ') : 'empty';
    await reply(sock, jid, msg, `📋 Antiemoji Mode: ${cfg.mode.toUpperCase()}\n📌 Watched Emojis: ${list}`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to list Antiemoji entries!', { mentions: [sender] });
  }
  break;
}

case 'clearemoji': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    await clearAntiemojiKeywords(jid);
    await reply(sock, jid, msg, '✅ All Antiemoji watched emojis have been cleared!', { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to clear Antiemoji entries!', { mentions: [sender] });
  }
  break;
}

case 'spamsettime': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    if (!(await isBotAdmin(metadata, botJid, sock))) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const timeMs = parseTimeArgToMs(args);
    if (!timeMs) {
      return await reply(sock, jid, msg, '⚠️ Usage: spamsettime 10 seconds\nspamsettime 50 seconds\nspamsettime 1 minutes', { mentions: [sender] });
    }
    await setGroupSpamConfig(jid, { timeMs });
    await reply(sock, jid, msg, `✅ Anti-Spam time window set to ${formatMs(timeMs)}.`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to set Anti-Spam time!', { mentions: [sender] });
  }
  break;
}

case 'spamsetpost': {
  try {
    if (!isGroupJid(jid)) {
      return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
    }
    const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
    if (!metadata) return;
    if (!(await isBotAdmin(metadata, botJid, sock))) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const senderAdmin = await isSenderAdmin(metadata, sender, sock);
    if (!senderAdmin && !isBotOwner) {
      return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
    }
    const postLimit = parsePostArgToCount(args);
    if (!postLimit) {
      return await reply(sock, jid, msg, '⚠️ Usage: spamsetpost 5 posts\nspamsetpost 10 posts\nspamsetpost 20 posts\nspamsetpost 50 posts', { mentions: [sender] });
    }
    await setGroupSpamConfig(jid, { postLimit });
    await reply(sock, jid, msg, `✅ Anti-Spam post limit set to ${postLimit} message(s).`, { mentions: [sender] });
  } catch (err) {
    console.error(err);
    await reply(sock, jid, msg, '❌ Failed to set Anti-Spam post limit!', { mentions: [sender] });
  }
  break;
}

  case 'gpdelall': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      if (!(await isBotAdmin(metadata, botJid, sock))) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const targets = getMentionedOrQuoted(msg).filter(t => normalizeNum(t) !== normalizeNum(botJid));
      if (targets.length === 0) {
        return await reply(sock, jid, msg, '⚠️ Mention or reply to the user whose messages you want to delete!', { mentions: [sender] });
      }
      const targetJid = targets[0];
      const targetNumber = normalizeNum(targetJid);

      const userStats = await getUserStats(jid, targetNumber);
      const keys = userStats?.keys || [];

      if (keys.length === 0) {
        return await reply(sock, jid, msg, '⚠️ No tracked messages found for this user in this group.', { mentions: [sender] });
      }

      await reply(sock, jid, msg, `🗑️ Deleting ${keys.length} message(s) from @${targetNumber}, please wait...`, { mentions: [targetJid] });

      let deleted = 0;
      for (const key of keys) {
        try {
          await sock.sendMessage(jid, { delete: key });
          deleted++;
        } catch (err) {
          console.error(err);
        }
        await sleep(300);
      }

      await clearUserMessages(jid, targetNumber);

      await reply(sock, jid, msg, `✅ Deleted ${deleted} of ${keys.length} tracked message(s) from @${targetNumber}.`, { mentions: [targetJid] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to delete all messages!', { mentions: [sender] });
    }
    break;
  }

  case 'gpcount': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      const targets = getMentionedOrQuoted(msg);
      if (targets.length === 0) {
        return await reply(sock, jid, msg, '⚠️ Mention or reply to the user you want to check!', { mentions: [sender] });
      }
      const targetJid = targets[0];
      const targetNumber = normalizeNum(targetJid);

      const userStats = await getUserStats(jid, targetNumber);
      const c = userStats?.counts || {
        image: 0, sticker: 0, text: 0, video: 0, audio: 0,
        voice: 0, document: 0, location: 0, invite: 0, links: 0
      };
      const totalPost = c.image + c.sticker + c.text + c.video + c.audio
        + c.voice + c.document + c.location + c.invite;

      const text = `📊 *Message Count Report*
👤 User: @${targetNumber}

Total post: ${totalPost}
Post: ${c.image}
Stickers: ${c.sticker}
Text message: ${c.text}
Video: ${c.video}
Audio: ${c.audio}
Voice notes: ${c.voice}
Documents: ${c.document}
Location: ${c.location}
Invite: ${c.invite}
Links: ${c.links}`;

      await reply(sock, jid, msg, text, { mentions: [targetJid] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get message count!', { mentions: [sender] });
    }
    break;
  }

  case 'gpallcount': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;

      const { totals, totalPost } = await getGroupTotals(jid);

      const text = `📊 *Group Total Message Count*

Total post: ${totalPost}
Total images: ${totals.image}
Total stickers: ${totals.sticker}
Total text message: ${totals.text}
Total video: ${totals.video}
Total audio: ${totals.audio}
Total voice notes: ${totals.voice}
Total documents: ${totals.document}
Total location: ${totals.location}
Total invite: ${totals.invite}
Total links: ${totals.links}`;

      await reply(sock, jid, msg, text, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get group message count!', { mentions: [sender] });
    }
    break;
  }

  case 'gpgetlink': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      if (!(await isBotAdmin(metadata, botJid, sock))) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const code = await sock.groupInviteCode(jid);
      await reply(sock, jid, msg, `🔗 Group Invite Link:\nhttps://chat.whatsapp.com/${code}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get group link!', { mentions: [sender] });
    }
    break;
  }

  case 'gprestartlink': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      if (!(await isBotAdmin(metadata, botJid, sock))) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const code = await sock.groupRevokeInvite(jid);
      await reply(sock, jid, msg, `🔄 Group link has been reset!\n🔗 New Link:\nhttps://chat.whatsapp.com/${code}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to restart group link!', { mentions: [sender] });
    }
    break;
  }

  case 'gpaddother': {
    try {
      const action = (args[0] || '').toLowerCase();
      if (action !== 'on' && action !== 'off') {
        return await reply(sock, jid, msg, '⚠️ Usage: gpaddother on OR gpaddother off', { mentions: [sender] });
      }
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      if (!(await isBotAdmin(metadata, botJid, sock))) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      await sock.groupMemberAddMode(jid, action === 'on' ? 'all_member_add' : 'admin_add');
      if (action === 'on') {
        await reply(sock, jid, msg, '✅ Add Other Members is now ON! All members can add new members.', { mentions: [sender] });
      } else {
        await reply(sock, jid, msg, '✅ Add Other Members is now OFF! Only  admins can add new members.', { mentions: [sender] });
      }
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to update Add Other Members setting!', { mentions: [sender] });
    }
    break;
  }

  case 'gpeditname': {
    try {
      const action = (args[0] || '').toLowerCase();
      if (action !== 'on' && action !== 'off') {
        return await reply(sock, jid, msg, '⚠️ Usage: gpeditname on OR gpeditname off', { mentions: [sender] });
      }
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      if (!(await isBotAdmin(metadata, botJid, sock))) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      await sock.groupSettingUpdate(jid, action === 'on' ? 'locked' : 'unlocked');
      if (action === 'on') {
        await reply(sock, jid, msg, '✅ Edit Name/Info setting is now ON! Only admins can edit group name, description and icon.', { mentions: [sender] });
      } else {
        await reply(sock, jid, msg, '✅ Edit Name/Info setting is now OFF! All members can edit group name, description and icon.', { mentions: [sender] });
      }
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to update Edit Name setting!', { mentions: [sender] });
    }
    break;
  }

  case 'gpupdates': {
    try {
      const action = (args[0] || '').toLowerCase();
      if (action !== 'on' && action !== 'off') {
        return await reply(sock, jid, msg, '⚠️ Usage: gpupdates on OR gpupdates off', { mentions: [sender] });
      }

      if (isGroupJid(jid)) {
        const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
        if (!metadata) return;
        const senderAdmin = await isSenderAdmin(metadata, sender, sock);
        if (!senderAdmin && !isBotOwner) {
          return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
        }
      } else if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }

      await setGpUpdatesStatus(action === 'on');

      if (action === 'on') {
        await reply(
          sock,
          jid,
          msg,
          '✅ Group Updates feature is now ON for all groups!\n\nFrom now on, whenever any admin adds, removes, promotes, or demotes a member in any group, the bot will send a full action report (action type, who performed it, target member, time and date) and silently hidetag all group members.',
          { mentions: [sender] }
        );
      } else {
        await reply(
          sock,
          jid,
          msg,
          '✅ Group Updates feature is now OFF for all groups!',
          { mentions: [sender] }
        );
      }
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to update Group Updates setting!', { mentions: [sender] });
    }
    break;
  }

  case 'logs': {
    if (!isBotOwner) {
      return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
    }
    const mode = (args[0] || '').trim().toLowerCase();
    if (mode !== 'on' && mode !== 'off') {
      const current = await getTerminalLogEnabled();
      return await reply(sock, jid, msg, `⚙️ Usage: logs on OR logs off\n\n📌 Currently: ${current ? 'ON' : 'OFF'}`, { mentions: [sender] });
    }
    try {
      await setTerminalLogEnabled(mode === 'on');
      await reply(sock, jid, msg, mode === 'on'
        ? '✅ Terminal message logging is now ON!'
        : '🛑 Terminal message logging is now OFF!', { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to update terminal logging setting!', { mentions: [sender] });
    }
    break;
  }
  case 'warn':
  case 'gpwarn': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      if (!(await isBotAdmin(metadata, botJid, sock))) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const targets = getMentionedOrQuoted(msg).filter(t => normalizeNum(t) !== normalizeNum(botJid));
      if (targets.length === 0) {
        return await reply(sock, jid, msg, '⚠️ Mention or reply to the user you want to gpwarn!\nUsage: gpwarn @user [reason]', { mentions: [sender] });
      }
      const target = targets[0];
      const targetNumber = normalizeNum(target);
      const reasonArgs = args.filter(a => !a.startsWith('@'));
      const reason = reasonArgs.length ? reasonArgs.join(' ') : 'No reason given';
      const count = await addWarn(jid, targetNumber);
      if (count >= MAX_WARNS) {
        await reply(sock, jid, msg, `🚫 @${targetNumber} has reached ${count}/${MAX_WARNS} warnings and is being removed from the group!\n📝 Reason: ${reason}`, { mentions: [target] });
        try {
          await sock.groupParticipantsUpdate(jid, [target], 'remove');
        } catch (err) {
          console.error(err);
        }
        await resetWarnUser(jid, targetNumber);
      } else {
        await reply(sock, jid, msg, `⚠️ @${targetNumber} has been warned!\n📊 Warnings: ${count}/${MAX_WARNS}\n📝 Reason: ${reason}`, { mentions: [target] });
      }
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to warn member!', { mentions: [sender] });
    }
    break;
  }

  case 'gpresetwarn': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const action = (args[0] || '').toLowerCase();
      if (action === 'all') {
        await resetWarnAll(jid);
        return await reply(sock, jid, msg, '✅ All warnings in this group have been reset!', { mentions: [sender] });
      }
      const targets = getMentionedOrQuoted(msg);
      if (targets.length === 0) {
        return await reply(sock, jid, msg, '⚠️ Mention or reply to the user, or use "gpresetwarn all"!\nUsage: gpresetwarn @user', { mentions: [sender] });
      }
      const target = targets[0];
      const targetNumber = normalizeNum(target);
      await resetWarnUser(jid, targetNumber);
      await reply(sock, jid, msg, `✅ Warnings for @${targetNumber} have been reset!`, { mentions: [target] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to reset warnings!', { mentions: [sender] });
    }
    break;
  }

  case 'resetlink': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      if (!(await isBotAdmin(metadata, botJid, sock))) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const senderAdmin = await isSenderAdmin(metadata, sender, sock);
      if (!senderAdmin && !isBotOwner) {
        return await reply(sock, jid, msg, config.onlygroupadmins, { mentions: [sender] });
      }
      const code = await sock.groupRevokeInvite(jid);
      await reply(sock, jid, msg, `🔄 Group invite link has been reset!\n🔗 New Link:\nhttps://chat.whatsapp.com/${code}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to reset group link!', { mentions: [sender] });
    }
    break;
  }

  case 'gpadminslist': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      const admins = metadata.participants.filter(p => p.admin);
      if (admins.length === 0) {
        return await reply(sock, jid, msg, '❌ No admins found in this group!', { mentions: [sender] });
      }
      const lines = [];
      const mentionIds = [];
      let count = 0;
      for (const p of admins) {
        const resolved = await resolveParticipantNumber(sock, p);
        count++;
        const role = p.admin === 'superadmin' ? '👑 Owner' : '🛡️ Admin';
        lines.push(`${count}. @${resolved.number} - ${role}`);
        mentionIds.push(resolved.id);
      }
      await reply(sock, jid, msg, `📋 *Group Admins (${count})*\n\n${lines.join('\n')}`, { mentions: mentionIds });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get admins list!', { mentions: [sender] });
    }
    break;
  }

  case 'gpmemberlist': {
    try {
      if (!isGroupJid(jid)) {
        return await reply(sock, jid, msg, config.replygroups, { mentions: [sender] });
      }
      const metadata = await ensureGroupMetadata(sock, jid, sender, msg);
      if (!metadata) return;
      const lines = [];
      const mentionIds = [];
      let count = 0;
      for (const p of metadata.participants) {
        const resolved = await resolveParticipantNumber(sock, p);
        count++;
        const role = p.admin === 'superadmin' ? ' (👑 Owner)' : p.admin === 'admin' ? ' (🛡️ Admin)' : '';
        lines.push(`${count}. @${resolved.number}${role}`);
        mentionIds.push(resolved.id);
      }
      await reply(sock, jid, msg, `📋 *Group Members (${count})*\n\n${lines.join('\n')}`, { mentions: mentionIds });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get members list!', { mentions: [sender] });
    }
    break;
  }

  case 'chid': {
    try {
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chid <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      const { chJid, resolvedMeta } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '❌ Could not resolve that link/code — make sure it is a valid whatsapp.com/channel link, invite code, or JID.', { mentions: [sender] });
      }
      let meta = resolvedMeta;
      if (!meta) {
        const rawMeta = await sock.newsletterMetadata('jid', chJid);
        meta = normalizeNewsletterMeta(rawMeta);
      }
      await reply(sock, jid, msg, `📌 Channel JID: ${chJid}\n📛 Name: ${meta?.name || 'N/A'}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get channel id!', { mentions: [sender] });
    }
    break;
  }

  case 'chinfo': {
    try {
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chinfo <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      const rawMeta = await sock.newsletterMetadata('jid', chJid);
      const meta = normalizeNewsletterMeta(rawMeta);
      if (!meta) {
        return await reply(sock, jid, msg, '❌ Could not fetch channel metadata! (Wrong JID or channel not accessible)', { mentions: [sender] });
      }
      const text = `📢 *${meta.name || 'N/A'}*\n\n`
        + `🆔 JID: ${chJid}\n`
        + `📝 Desc: ${meta.description || 'N/A'}\n`
        + `👥 Subscribers: ${meta.subscribers ?? 'N/A'}\n`
        + `🛡️ Verified: ${meta.verification || 'N/A'}\n`
        + `👤 Your Role: ${meta.role || 'N/A'}`;
      await reply(sock, jid, msg, text, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get channel info!', { mentions: [sender] });
    }
    break;
  }

  case 'chfollow': {
    try {
      if (!args[0]) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chfollow <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      let chJid = args[0];
      let chName = '';
      if (!chJid.endsWith('@newsletter')) {
        const code = extractInviteCode(chJid) || chJid;
        const rawMeta = await sock.newsletterMetadata('invite', code);
        const meta = normalizeNewsletterMeta(rawMeta);
        if (!meta || !meta.id) {
          return await reply(sock, jid, msg, '❌ Invalid channel link/invite code, channel not found!', { mentions: [sender] });
        }
        chJid = meta.id;
        chName = meta.name || '';
      } else {
        try {
          const rawMeta = await sock.newsletterMetadata('jid', chJid);
          const meta = normalizeNewsletterMeta(rawMeta);
          chName = meta?.name || '';
        } catch {}
      }
      await sock.newsletterFollow(chJid);
      await trackChannel(chJid, chName);
      await reply(sock, jid, msg, `✅ Followed channel: ${chName || chJid}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to follow channel!', { mentions: [sender] });
    }
    break;
  }

  case 'chunfollow': {
    try {
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chunfollow <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      await sock.newsletterUnfollow(chJid);
      await untrackChannel(chJid);
      await reply(sock, jid, msg, `✅ Unfollowed channel: ${chJid}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to unfollow channel!', { mentions: [sender] });
    }
    break;
  }

  case 'challunfollow': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const list = await getTrackedChannels();
      if (list.length === 0) {
        return await reply(sock, jid, msg, 'ℹ️ No tracked channels to unfollow.', { mentions: [sender] });
      }
      let ok = 0, fail = 0;
      for (const ch of list) {
        try {
          await sock.newsletterUnfollow(ch.jid);
          ok++;
        } catch {
          fail++;
        }
      }
      await saveTrackedChannels([]);
      await reply(sock, jid, msg, `✅ Unfollow complete!\nSuccess: ${ok}\nFailed: ${fail}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to unfollow all channels!', { mentions: [sender] });
    }
    break;
  }

  case 'chlist': {
    try {
      const list = await getTrackedChannels();
      if (list.length === 0) {
        return await reply(sock, jid, msg, 'ℹ️ No tracked channels yet. Use chcreate or chfollow first.', { mentions: [sender] });
      }
      const text = list.map((c, i) => `${i + 1}. ${c.name || 'N/A'}\n   ${c.jid}`).join('\n\n');
      await reply(sock, jid, msg, `📋 *Tracked Channels (${list.length})*\n\n${text}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to list channels!', { mentions: [sender] });
    }
    break;
  }

  case 'chcreate': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const raw = args.join(' ');
      if (!raw) {
        return await reply(sock, jid, msg, '⚠️ Usage: chcreate <name> | <description>', { mentions: [sender] });
      }
      const [chName, chDesc] = raw.split('|').map((s) => s?.trim());
      if (!chName) {
        return await reply(sock, jid, msg, '⚠️ Usage: chcreate <name> | <description>', { mentions: [sender] });
      }
      const meta = await sock.newsletterCreate(chName, chDesc || '');
      await trackChannel(meta.id, meta.name);
      await reply(sock, jid, msg, `✅ Channel created!\n📛 Name: ${meta.name}\n🆔 JID: ${meta.id}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to create channel!', { mentions: [sender] });
    }
    break;
  }

  case 'chdelete': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chdelete <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      await sock.newsletterDelete(chJid);
      await untrackChannel(chJid);
      await reply(sock, jid, msg, `✅ Channel deleted: ${chJid}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to delete channel! (Only channels the bot owns can be deleted)', { mentions: [sender] });
    }
    break;
  }

  case 'chsubscribers': {
    try {
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chsubscribers <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      let count;
      try {
        const res = await sock.newsletterSubscribers(chJid);
        count = typeof res === 'number' ? res : (res?.subscribers_count ?? res?.count ?? res?.subscribers);
      } catch {}
      if (count === undefined || count === null) {
        const rawMeta = await sock.newsletterMetadata('jid', chJid);
        const meta = normalizeNewsletterMeta(rawMeta);
        count = meta?.subscribers;
      }
      await reply(sock, jid, msg, `👥 Subscribers: ${count ?? 'N/A'}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get subscriber count!', { mentions: [sender] });
    }
    break;
  }

  case 'chadmincount': {
    try {
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chadmincount <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      const count = await sock.newsletterAdminCount(chJid);
      await reply(sock, jid, msg, `🛡️ Admin count: ${count}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get admin count!', { mentions: [sender] });
    }
    break;
  }

  case 'chgetpic': {
    try {
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chgetpic <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      const rawMeta = await sock.newsletterMetadata('jid', chJid).catch(() => null);
      const meta = normalizeNewsletterMeta(rawMeta);
      let ppUrl = meta?.pictureUrl || null;
      if (!ppUrl) {
        ppUrl = await sock.profilePictureUrl(chJid, 'image').catch(() => null);
      }
      if (!ppUrl) {
        return await reply(sock, jid, msg, '📭 This channel has no profile picture.', { mentions: [sender] });
      }
      await replyImage(sock, jid, msg, { url: ppUrl }, undefined, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get channel profile picture!', { mentions: [sender] });
    }
    break;
  }

  case 'chdelpic': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chdelpic <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      await sock.newsletterRemovePicture(chJid);
      await reply(sock, jid, msg, '✅ Channel profile picture removed!', { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to remove channel picture!', { mentions: [sender] });
    }
    break;
  }

  case 'chsetpic': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link/code/JID (and reply to an image).\nUsage: chsetpic <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      const imageMsg = getQuotedImageMsg(msg);
      if (!imageMsg) {
        return await reply(sock, jid, msg, '⚠️ Please send or reply to an image to set as channel profile picture.', { mentions: [sender] });
      }
      const buffer = await downloadMediaMessage(
        { message: { imageMessage: imageMsg } },
        'buffer',
        {},
        { logger }
      );
      if (!buffer || buffer.length === 0) {
        return await reply(sock, jid, msg, '❌ Failed to download image!', { mentions: [sender] });
      }
      await sock.newsletterUpdatePicture(chJid, buffer);
      await reply(sock, jid, msg, '✅ Channel profile picture updated successfully!', { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to update channel picture!', { mentions: [sender] });
    }
    break;
  }

  case 'chgetdesc': {
    try {
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chgetdesc <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      const rawMeta = await sock.newsletterMetadata('jid', chJid);
      const meta = normalizeNewsletterMeta(rawMeta);
      await reply(sock, jid, msg, `📝 Description:\n${meta?.description || 'N/A'}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get channel description!', { mentions: [sender] });
    }
    break;
  }

  case 'chgetname': {
    try {
      const { chJid } = await resolveChannelTarget(sock, args);
      if (!chJid) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link, invite code, or JID.\nUsage: chgetname <channel_link | invite_code | jid>', { mentions: [sender] });
      }
      const rawMeta = await sock.newsletterMetadata('jid', chJid);
      const meta = normalizeNewsletterMeta(rawMeta);
      await reply(sock, jid, msg, `📛 Name: ${meta?.name || 'N/A'}`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to get channel name!', { mentions: [sender] });
    }
    break;
  }

  case 'chsendtext': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const { chJid, rest } = await resolveChannelTarget(sock, args);
      const text = rest.join(' ');
      if (!chJid || !text) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link/code/JID.\nUsage: chsendtext <channel_link | invite_code | jid> <message>', { mentions: [sender] });
      }
      await sock.sendMessage(chJid, { text });
      await reply(sock, jid, msg, '✅ Message posted to channel!', { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to post to channel! (Bot must be the channel owner/admin)', { mentions: [sender] });
    }
    break;
  }

  case 'chsendimage': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const { chJid, rest } = await resolveChannelTarget(sock, args);
      const caption = rest.join(' ');
      const imageMsg = getQuotedImageMsg(msg);
      if (!chJid || !imageMsg) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link/code/JID (and reply to an image).\nUsage: chsendimage <channel_link | invite_code | jid> <caption>', { mentions: [sender] });
      }
      const buffer = await downloadMediaMessage(
        { message: { imageMessage: imageMsg } },
        'buffer',
        {},
        { logger }
      );
      await sock.sendMessage(chJid, { image: buffer, caption: caption || '' });
      await reply(sock, jid, msg, '✅ Image posted to channel!', { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to post image to channel!', { mentions: [sender] });
    }
    break;
  }

  case 'chsendvideo': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const { chJid, rest } = await resolveChannelTarget(sock, args);
      const caption = rest.join(' ');
      const videoMsg = getQuotedVideoMsg(msg);
      if (!chJid || !videoMsg) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link/code/JID (and reply to a video).\nUsage: chsendvideo <channel_link | invite_code | jid> <caption>', { mentions: [sender] });
      }
      const buffer = await downloadMediaMessage(
        { message: { videoMessage: videoMsg } },
        'buffer',
        {},
        { logger }
      );
      await sock.sendMessage(chJid, { video: buffer, caption: caption || '' });
      await reply(sock, jid, msg, '✅ Video posted to channel!', { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to post video to channel!', { mentions: [sender] });
    }
    break;
  }

  case 'chmakeadmin': {
    try {
      if (!isBotOwner) {
        return await reply(sock, jid, msg, config.mainowner, { mentions: [sender] });
      }
      const { chJid, rest } = await resolveChannelTarget(sock, args);
      const number = (rest[0] || '').replace(/[^0-9]/g, '');
      if (!chJid || !number) {
        return await reply(sock, jid, msg, '⚠️ Please provide the channel link/code/JID and the number.\nUsage: chmakeadmin <channel_link | invite_code | jid> <number>', { mentions: [sender] });
      }
      const rawMeta = await sock.newsletterMetadata('jid', chJid);
      const meta = normalizeNewsletterMeta(rawMeta);
      const targetJid = `${number}@s.whatsapp.net`;
      await sock.sendMessage(targetJid, {
        adminInvite: {
          jid: chJid,
          name: meta?.name || global.chname || 'Channel',
          caption: 'You have been invited to become a channel admin.',
          expiration: 86400,
        },
      });
      await reply(sock, jid, msg, `✅ Admin invite sent to +${number}.\nℹ️ Note: this is only an invite — they must accept it themselves; there is no API to force-promote a channel admin.`, { mentions: [sender] });
    } catch (err) {
      console.error(err);
      await reply(sock, jid, msg, '❌ Failed to send admin invite!', { mentions: [sender] });
    }
    break;
  }

  }
}

module.exports = {
  handleCommand,
  extractCommandFromMessage,
  isGroupLocked,
  isSenderAdmin,
  resolveNumberCandidates,
  checkAndHandleSpam,
  checkAndHandleAntilink,
  checkAndHandleAntiwords,
  checkAndHandleAntiemoji,
  getTerminalLogEnabled,
  setTerminalLogEnabled,
  reply,
  trackMessage,
  getGpUpdatesStatus,
  setGpUpdatesStatus,
  handleGroupParticipantsUpdate,
  handleWelcomeGoodbye,
  handleGpSafeProtection,
  handleGpSettingsProtection,
  refreshLidCache,
  startLidCacheAutoRefresh,
  cacheAntideleteMessage,
  handleAntideleteRevoke,
  handleAntideleteMeRevoke,
  cachePMAntideleteMessage,
  handlePMAntideleteRevoke,
  handlePMAntideleteMeRevoke,
  isPrivateJid,
  getWarnCount,
  addWarn,
  resetWarnUser,
  resetWarnAll,
  handleAutoTyping,
  handleAutoReact,
  runAlwaysOnlineTick,
  handleAutoStatusDownload,
  handleAutoBlockingDM,
  handleAutoReply,
  handleIncomingCall,
  registerContactsFromEvent,
  handleAutoStatusViews,
  handleAutoStatusReact,
  handleAutoRead,
  handleAutoRecording,
};

require('fs').watchFile(require.resolve(__filename), { interval: 500 }, () => {
  console.log('\x1b[0;32m' + __filename + ' \x1b[1;32mupdated!\x1b[0m');
  require('fs').unwatchFile(require.resolve(__filename));
  delete require.cache[require.resolve(__filename)];
  require(__filename);
});