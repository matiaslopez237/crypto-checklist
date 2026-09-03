const API = "https://api.telegram.org/bot";

export function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[dry-run, no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID set] would send:\n" + text);
    return;
  }

  const res = await fetch(`${API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

// Long-poll-free fetch of pending updates since `offset`, filtered to the configured chat.
export async function getUpdatesFromOwner(offset) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[dry-run, no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID set] skipping getUpdates");
    return { updates: [], nextOffset: offset };
  }

  const url = `${API}${token}/getUpdates?offset=${offset}&timeout=0`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const all = data.result ?? [];
  let nextOffset = offset;
  const ownMessages = [];

  for (const update of all) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
    const msg = update.message;
    // Ignore anyone but the configured owner — this bot's commands write to the repo.
    if (msg && msg.text && String(msg.chat?.id) === String(chatId)) {
      ownMessages.push(msg.text.trim());
    }
  }

  return { updates: ownMessages, nextOffset };
}
