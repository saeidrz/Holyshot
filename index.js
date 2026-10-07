const express = require('express');
const { Telegraf } = require('telegraf');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const port = process.env.PORT || 3000;
const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error('BOT_TOKEN is required');
}

const adminIds = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
if (adminIds.size === 0) {
  console.warn('ADMIN_IDS is empty: the bot will ignore everyone.');
}

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'voices.json');
const STATE_TTL_MS = 10 * 60 * 1000;
const DATE_RE = /^\d{4}\/\d{1,2}\/\d{1,2}$/;

let voices = [];
try {
  voices = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  voices = [];
}

function saveVoices() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(voices, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function nextId() {
  return voices.reduce((max, v) => Math.max(max, Number(v.id) || 0), 0) + 1;
}

function publicVoice(v) {
  return { id: v.id, text: v.text, date: v.date, audioUrl: '/audio/' + v.id };
}

const app = express();
const bot = new Telegraf(token);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/voices', (req, res) => {
  res.json(voices.map(publicVoice));
});

app.get('/audio/:id', async (req, res) => {
  const voice = voices.find((v) => String(v.id) === req.params.id);
  if (!voice) return res.sendStatus(404);
  try {
    const link = await bot.telegram.getFileLink(voice.fileId);
    const upstream = await fetch(link.href);
    if (!upstream.ok || !upstream.body) return res.sendStatus(502);
    res.set('Content-Type', 'audio/ogg');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('audio proxy failed:', err.message);
    res.sendStatus(502);
  }
});

const server = app.listen(port, () => {
  console.log('Server running on port ' + port);
});

const wss = new WebSocket.Server({ server });

function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('error', (err) => console.error('ws error:', err.message));
  ws.send(JSON.stringify({ type: 'init', voices: voices.map(publicVoice) }));
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const userStates = {};

function getState(ctx) {
  const state = userStates[ctx.from.id];
  if (state && Date.now() - state.ts > STATE_TTL_MS) {
    delete userStates[ctx.from.id];
    return null;
  }
  return state || null;
}

function setState(ctx, data) {
  userStates[ctx.from.id] = Object.assign({ ts: Date.now() }, data);
}

bot.use((ctx, next) => {
  if (!ctx.from || !adminIds.has(String(ctx.from.id))) return;
  return next();
});

bot.command('addvoice', (ctx) => {
  setState(ctx, { step: 'awaitingAudio' });
  return ctx.reply('لطفا فایل صوتی را ارسال کنید:');
});

bot.command('deletevoice', (ctx) => {
  setState(ctx, { step: 'awaitingDeleteId' });
  return ctx.reply('لطفا شناسه صدای مورد نظر را وارد کنید:');
});

bot.command('edittext', (ctx) => {
  setState(ctx, { step: 'awaitingEditId' });
  return ctx.reply('شناسه صدایی که میخواهید متنش تغییر کند را وارد کنید:');
});

bot.command('list', (ctx) => {
  if (voices.length === 0) return ctx.reply('هنوز صدایی ثبت نشده است.');
  const lines = voices.map((v) => v.id + ' | ' + v.date + ' | ' + v.text);
  return ctx.reply(lines.join('\n'));
});

bot.command('cancel', (ctx) => {
  delete userStates[ctx.from.id];
  return ctx.reply('مکالمه فعلی لغو شد.');
});

bot.on('voice', (ctx) => {
  const state = getState(ctx);
  if (state && state.step === 'awaitingAudio') {
    state.audioFileId = ctx.message.voice.file_id;
    state.step = 'awaitingText';
    state.ts = Date.now();
    return ctx.reply('لطفا متن صدا را وارد کنید:');
  }
  return ctx.reply('برای افزودن صدا از دستور /addvoice استفاده کنید.');
});

bot.on('text', (ctx) => {
  const state = getState(ctx);
  if (!state) return;
  const input = ctx.message.text.trim();
  state.ts = Date.now();

  if (state.step === 'awaitingText') {
    if (!input) return ctx.reply('متن نمی‌تواند خالی باشد.');
    state.text = input;
    state.step = 'awaitingDate';
    return ctx.reply('لطفا تاریخ را وارد کنید (مثلا 1402/05/15):');
  }

  if (state.step === 'awaitingDate') {
    if (!DATE_RE.test(input)) {
      return ctx.reply('فرمت تاریخ درست نیست. نمونه: 1402/05/15');
    }
    const voice = {
      id: nextId(),
      fileId: state.audioFileId,
      text: state.text,
      date: input,
    };
    voices.push(voice);
    saveVoices();
    broadcast(Object.assign({ type: 'addVoice' }, publicVoice(voice)));
    delete userStates[ctx.from.id];
    return ctx.reply('✅ صدا با شناسه ' + voice.id + ' اضافه شد.\nمتن: ' + voice.text + '\nتاریخ: ' + voice.date);
  }

  if (state.step === 'awaitingDeleteId') {
    const index = voices.findIndex((v) => String(v.id) === input);
    if (index === -1) return ctx.reply('صدایی با این شناسه پیدا نشد.');
    const removed = voices.splice(index, 1)[0];
    saveVoices();
    broadcast({ type: 'deleteVoice', id: removed.id });
    delete userStates[ctx.from.id];
    return ctx.reply('🗑 صدا با شناسه ' + removed.id + ' حذف شد.');
  }

  if (state.step === 'awaitingEditId') {
    const voice = voices.find((v) => String(v.id) === input);
    if (!voice) return ctx.reply('صدایی با این شناسه پیدا نشد.');
    state.voiceId = voice.id;
    state.step = 'awaitingNewText';
    return ctx.reply('متن جدید را وارد کنید:');
  }

  if (state.step === 'awaitingNewText') {
    const voice = voices.find((v) => v.id === state.voiceId);
    if (!voice) {
      delete userStates[ctx.from.id];
      return ctx.reply('این صدا دیگر وجود ندارد.');
    }
    if (!input) return ctx.reply('متن نمی‌تواند خالی باشد.');
    voice.text = input;
    saveVoices();
    broadcast({ type: 'editText', id: voice.id, text: voice.text });
    delete userStates[ctx.from.id];
    return ctx.reply('✏ متن صدا تغییر کرد به: ' + voice.text);
  }
});

bot.catch((err) => {
  console.error('bot error:', err);
});

bot.launch().catch((err) => {
  console.error('bot launch failed:', err);
  process.exit(1);
});

function shutdown(signal) {
  clearInterval(heartbeat);
  bot.stop(signal);
  wss.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
