/** Built by Aditya Waghamare */

// ==================== ALERT NOTIFICATION ENGINE ====================
// Supports: Telegram Bot API, Discord Webhooks, Generic Webhook URL
// Events: key exhaustion, bounty submission/acceptance, crashes, daily summary

export type AlertEvent =
  | "key_rate_limited"
  | "key_quota_exhausted"
  | "key_invalid"
  | "provider_all_keys_exhausted"
  | "bounty_submitted"
  | "bounty_accepted"
  | "bounty_failed"
  | "process_crash"
  | "process_restart"
  | "daily_summary"
  | "agent_paused"
  | "agent_resumed";

export interface AlertPayload {
  event: AlertEvent;
  message: string;
  details?: Record<string, unknown>;
  timestamp?: number;
}

// Emoji map for event types
const EVENT_EMOJI: Record<AlertEvent, string> = {
  key_rate_limited: "⏳",
  key_quota_exhausted: "🔴",
  key_invalid: "🚫",
  provider_all_keys_exhausted: "🔴",
  bounty_submitted: "🟡",
  bounty_accepted: "🟢",
  bounty_failed: "❌",
  process_crash: "💥",
  process_restart: "🔄",
  daily_summary: "📊",
  agent_paused: "⏸️",
  agent_resumed: "▶️",
};

// Event severity for filtering (only send high-priority alerts)
const EVENT_PRIORITY: Record<AlertEvent, "low" | "medium" | "high" | "critical"> = {
  key_rate_limited: "low",
  key_quota_exhausted: "medium",
  key_invalid: "medium",
  provider_all_keys_exhausted: "critical",
  bounty_submitted: "medium",
  bounty_accepted: "high",
  bounty_failed: "medium",
  process_crash: "critical",
  process_restart: "high",
  daily_summary: "low",
  agent_paused: "high",
  agent_resumed: "medium",
};

// Rate limiting: prevent alert spam (max 1 alert per event type per 60s)
const lastAlertTime = new Map<AlertEvent, number>();
const ALERT_COOLDOWN_MS = 60_000;

/**
 * Send an alert notification to all configured channels.
 * Automatically formats for Telegram, Discord, or generic webhook.
 * Rate-limited to prevent spam during cascade failures.
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  const now = Date.now();
  const lastTime = lastAlertTime.get(payload.event) || 0;

  // Rate limit: skip if same event type fired within cooldown
  // Exception: critical events always go through
  if (
    EVENT_PRIORITY[payload.event] !== "critical" &&
    now - lastTime < ALERT_COOLDOWN_MS
  ) {
    return;
  }

  lastAlertTime.set(payload.event, now);

  const timestamp = payload.timestamp || now;
  const emoji = EVENT_EMOJI[payload.event] || "📢";

  // Fire all channels in parallel, don't block on failures
  const promises: Promise<void>[] = [];

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    promises.push(sendTelegram(emoji, payload, timestamp));
  }

  if (process.env.DISCORD_WEBHOOK_URL) {
    promises.push(sendDiscord(emoji, payload, timestamp));
  }

  if (process.env.ALERT_WEBHOOK_URL) {
    promises.push(sendGenericWebhook(payload, timestamp));
  }

  await Promise.allSettled(promises);
}

// ==================== TELEGRAM ====================

async function sendTelegram(
  emoji: string,
  payload: AlertPayload,
  timestamp: number,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;

  const timeStr = new Date(timestamp).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

  // Build Telegram HTML message
  let text = `${emoji} <b>AgentClaw</b> — ${formatEventName(payload.event)}\n`;
  text += `<i>${timeStr} IST</i>\n\n`;
  text += payload.message;

  if (payload.details && Object.keys(payload.details).length > 0) {
    text += "\n\n<b>Details:</b>\n";
    for (const [key, value] of Object.entries(payload.details)) {
      text += `• <code>${key}</code>: ${String(value)}\n`;
    }
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.warn(`⚠️ [Telegram Alert] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ==================== DISCORD ====================

async function sendDiscord(
  emoji: string,
  payload: AlertPayload,
  timestamp: number,
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL!;

  const priority = EVENT_PRIORITY[payload.event];
  const color =
    priority === "critical"
      ? 0xff0000
      : priority === "high"
      ? 0xff8c00
      : priority === "medium"
      ? 0xffd700
      : 0x00bfff;

  const embed = {
    title: `${emoji} ${formatEventName(payload.event)}`,
    description: payload.message,
    color,
    timestamp: new Date(timestamp).toISOString(),
    footer: { text: "AgentClaw Engine" },
    fields: payload.details
      ? Object.entries(payload.details).map(([key, value]) => ({
          name: key,
          value: String(value),
          inline: true,
        }))
      : [],
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "AgentClaw",
        embeds: [embed],
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.warn(`⚠️ [Discord Alert] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ==================== GENERIC WEBHOOK ====================

async function sendGenericWebhook(
  payload: AlertPayload,
  timestamp: number,
): Promise<void> {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL!;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: payload.event,
        message: payload.message,
        timestamp,
        agent: "AgentClaw",
        priority: EVENT_PRIORITY[payload.event],
        ...payload.details,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.warn(`⚠️ [Webhook Alert] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ==================== HELPERS ====================

function formatEventName(event: AlertEvent): string {
  return event
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Prune stale entries from the rate-limit map to prevent memory growth.
 * Called periodically (e.g., every heartbeat tick).
 */
export function pruneAlertCooldowns(): void {
  const now = Date.now();
  for (const [event, time] of lastAlertTime) {
    if (now - time > ALERT_COOLDOWN_MS * 5) {
      lastAlertTime.delete(event);
    }
  }
}
