// One-time Telegram helper.
//   1) Set TELEGRAM_BOT_TOKEN, send your bot any message, then run: node src/telegram-setup.js
//      -> prints your chat ID
//   2) Also set TELEGRAM_CHAT_ID and run: node src/telegram-setup.js --test
//      -> sends a test message
import { sendTelegram } from './telegram.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN first (the token BotFather gave you).');
  process.exit(1);
}

if (process.argv.includes('--test')) {
  if (!process.env.TELEGRAM_CHAT_ID) {
    console.error('Set TELEGRAM_CHAT_ID too.');
    process.exit(1);
  }
  const ok = await sendTelegram('✅ FOMO Signal Monitor is connected. Alerts will arrive here.');
  console.log(ok ? 'Test message sent. Check Telegram.' : 'Sending failed (see error above).');
  process.exit(ok ? 0 : 1);
}

const j = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
if (!j.ok) {
  console.error(`Telegram says: ${j.description}. Check the token.`);
  process.exit(1);
}
const chats = new Map(j.result.map((u) => (u.message ?? u.my_chat_member)?.chat).filter(Boolean).map((c) => [c.id, c]));
if (!chats.size) console.log('No messages found. Open your bot in Telegram, press Start (or send "hi"), then run this again.');
for (const c of chats.values()) console.log(`Chat ID: ${c.id}  (${c.first_name ?? c.title ?? ''} ${c.username ? '@' + c.username : ''})`);
