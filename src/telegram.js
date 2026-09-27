// Telegram delivery. Without TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID set, messages are printed instead.
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendTelegram(html, { dryRun = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (dryRun || !token || !chatId) {
    console.log(`\n----- Telegram message (not sent) -----\n${html}\n---------------------------------------\n`);
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json();
      if (j.ok) return true;
      console.error(`Telegram error: ${j.description}`);
      if (res.status < 500 && res.status !== 429) return false;
    } catch (e) {
      console.error(`Telegram send failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  return false;
}
