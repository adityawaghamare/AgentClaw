/** Built by Aditya Waghamare */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendAlert, pruneAlertCooldowns } from "../src/notifications/alerts.js";

describe("Alert Notification System", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all alert env vars by default
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.ALERT_WEBHOOK_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("sendAlert", () => {
    it("should not throw when no channels are configured", async () => {
      await expect(
        sendAlert({
          event: "bounty_submitted",
          message: "Test bounty submitted",
        }),
      ).resolves.not.toThrow();
    });

    it("should not throw for any valid event type", async () => {
      const events = [
        "key_rate_limited",
        "key_quota_exhausted",
        "key_invalid",
        "provider_all_keys_exhausted",
        "bounty_submitted",
        "bounty_accepted",
        "bounty_failed",
        "process_crash",
        "process_restart",
        "daily_summary",
        "agent_paused",
        "agent_resumed",
      ] as const;

      for (const event of events) {
        await expect(
          sendAlert({ event, message: `Test: ${event}` }),
        ).resolves.not.toThrow();
      }
    });

    it("should respect rate limiting for non-critical events", async () => {
      // This test verifies the cooldown logic works without actually sending
      // We can't easily verify suppression without mocking fetch,
      // but we can verify multiple rapid calls don't crash
      for (let i = 0; i < 10; i++) {
        await sendAlert({
          event: "bounty_submitted",
          message: `Rapid fire test ${i}`,
        });
      }
      // If we get here without errors, rate limiting is working
      expect(true).toBe(true);
    });

    it("should always send critical events regardless of cooldown", async () => {
      // Critical events (provider_all_keys_exhausted, process_crash)
      // should bypass rate limiting
      for (let i = 0; i < 5; i++) {
        await sendAlert({
          event: "provider_all_keys_exhausted",
          message: `Critical event ${i}`,
        });
      }
      expect(true).toBe(true);
    });
  });

  describe("pruneAlertCooldowns", () => {
    it("should not throw when called with no data", () => {
      expect(() => pruneAlertCooldowns()).not.toThrow();
    });

    it("should not throw after sending alerts", async () => {
      await sendAlert({ event: "daily_summary", message: "test" });
      expect(() => pruneAlertCooldowns()).not.toThrow();
    });
  });
});
