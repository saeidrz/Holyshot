const express = require('express');
const { Telegraf } = require('telegraf');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;  // پورت داینامیک برای Render

// توکن ربات تلگرام (توکن واقعی‌ات رو جایگزین کن)
const bot = new Telegraf('8267992806:AAH5JWTg9u5GJ_opIDHU4joS9Q5FRVQWlto');

// پوشه public برای فایل‌های استاتیک سایت
app.use(express.static(path.join(__dirname, 'public')));

// راه‌اندازی سرور و گوش دادن روی پورت
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// WebSocket روی همان سرور Express
const wss = new WebSocket.Server({ server });

// تابع ارسال پیام به همه کلاینت‌ها
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// وضعیت هر کاربر برای مدیریت حالت مکالمه
const userStates = {};

// دستور /addvoice
bot.command('addvoice', (ctx) => {
  userStates[ctx.from.id] = { step: 'awaitingAudio' };
  ctx.reply('لطفا فایل صوتی را ارسال کنید:');
});

// دریافت فایل صوتی
bot.on('voice', (ctx) => {
  const state = userStates[ctx.from.id];
  if (state && state.step === 'awaitingAudio') {
    state.audioFileId = ctx.message.voice.file_id;
    state.step = 'awaitingText';
    ctx.reply('لطفا متن صدا را وارد کنید:');
  } else {
    ctx.reply('برای افزودن صدا از دستور /addvoice استفاده کنید.');
  }
});

// هندلر واحد برای پیام‌های متنی
bot.on('text', (ctx) => {
  const state = userStates[ctx.from.id];
  if (!state) return;

  if (state.step === 'awaitingText') {
    state.text = ctx.message.text;
    state.step = 'awaitingDate';
    ctx.reply('لطفا تاریخ را وارد کنید (مثلا 1402/05/15):');

  } else if (state.step === 'awaitingDate') {
    state.date = ctx.message.text;

    broadcast({
      type: 'addVoice',
      fileId: state.audioFileId,
      text: state.text,
      date: state.date
    });

    ctx.reply(`✅ صدا با موفقیت اضافه شد.\nمتن: ${state.text}\nتاریخ: ${state.date}`);
    delete userStates[ctx.from.id];

  } else if (state.step === 'awaitingDeleteId') {
    broadcast({ type: 'deleteVoice', id: ctx.message.text });
    ctx.reply(`🗑 صدا با شناسه ${ctx.message.text} حذف شد.`);
    delete userStates[ctx.from.id];

  } else if (state.step === 'awaitingEditId') {
    state.voiceId = ctx.message.text;
    state.step = 'awaitingNewText';
    ctx.reply('متن جدید را وارد کنید:');

  } else if (state.step === 'awaitingNewText') {
    broadcast({ type: 'editText', id: state.voiceId, text: ctx.message.text });
    ctx.reply(`✏ متن صدا تغییر کرد به: ${ctx.message.text}`);
    delete userStates[ctx.from.id];
  }
});

// دستور /deletevoice
bot.command('deletevoice', (ctx) => {
  userStates[ctx.from.id] = { step: 'awaitingDeleteId' };
  ctx.reply('لطفا شناسه صدای مورد نظر را وارد کنید:');
});

// دستور /edittext
bot.command('edittext', (ctx) => {
  userStates[ctx.from.id] = { step: 'awaitingEditId' };
  ctx.reply('شناسه صدایی که میخواهید متنش تغییر کند را وارد کنید:');
});

// راه‌اندازی ربات تلگرام
bot.launch();

// خاموش کردن صحیح ربات در زمان متوقف شدن سرور
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
