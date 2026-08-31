/**
   * Base By Mr Legend
   * Create By Lwazi
   * Contact Me on wa.me/27736324314
   *Follow WhatsApp Channel
   * https://whatsapp.com/channel/0029VbDK7drI1rcoEQNE1K3S
   * Follow YouTube Channel
   https://www.youtube.com/@lwazi
**/

const fs = require('fs');
const path = require('path');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const boxStyles = {
  square: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '━', v: '┃' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  simple: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  star: { tl: '✦', tr: '✦', bl: '✦', br: '✦', h: '─', v: '│' },
};

global.chid = '120363427699653625@newsletter';
global.chname = '卩Ꝛㄖ⤐͠Ｘ＝𝗠𝗗';


module.exports = {
  publicMode: true,
  BotName: packageJson.name,
  BotVersion: packageJson.version,
  DeveloperName: "lwazi",
  onlygroupadmins: '⚠️ Only group admins can use this command!',
  replygroups: '⚠️ This command only works in groups!',
  mainowner: '❌ This command can only be used by the Bot Owner!',
  PairCoadName: '00000000',
  specialNumbersUrl: 'https://raw.githubusercontent.com/lwazi',

  box: {
    enabled: true,
    style: 'star',
    width: 22,
  },
  boxStyles,

  boxify(input) {
    if (this.box && this.box.enabled === false) return String(input == null ? '' : input);
    const text = String(input == null ? '' : input);
    const lines = text.split('\n');
    const cfg = this.box || {};
    const style = boxStyles[cfg.style] || boxStyles.square;
    const width = cfg.width || 30;

    const horizontal = style.h.repeat(width);
    const dividerLine = `${style.v} ${style.h.repeat(Math.max(width - 2, 1))}`;
    const body = lines
      .map((line) => (line.trim() === '' ? dividerLine : `${style.v} ${line}`))
      .join('\n');
    return `${style.tl}${horizontal}\n${body}\n${style.bl}${horizontal}`;
  },

  applyBoxWrapper(sock) {
    const originalSendMessage = sock.sendMessage.bind(sock);

    sock.sendMessage = async (jid, content, options) => {
      const liveConfig = require(__filename);
      if (content && typeof content === 'object') {
        if (typeof content.text === 'string' && content.text.length > 0) {
          content = { ...content, text: liveConfig.boxify(content.text) };
        } else if (typeof content.caption === 'string' && content.caption.length > 0) {
          content = { ...content, caption: liveConfig.boxify(content.caption) };
        }
      }
      return originalSendMessage(jid, content, options);
    };

    return sock;
  },
};

require('fs').watchFile(require.resolve(__filename), { interval: 500 }, () => {
  console.log('\x1b[0;32m' + __filename + ' \x1b[1;32mupdated!\x1b[0m');
  require('fs').unwatchFile(require.resolve(__filename));
  delete require.cache[require.resolve(__filename)];
  require(__filename);
});
