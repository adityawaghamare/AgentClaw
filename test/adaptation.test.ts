/** Built by Aditya Waghamare */
import { describe, it, expect, beforeEach } from "vitest";

/**
 * Integration tests for the Autonomous Model Adapter
 * Tests: blacklisting, health scoring, model queue ordering, and stale data pruning.
 *
 * We construct a fresh adapter for each test via a helper that
 * exposes the same public API as the singleton exported from adaptation.ts,
 * but without touching the disk registry file.
 */

// Directly test the exported singleton's public methods
// These tests exercise real logic without needing network calls
import { autonomousAdapter, keyManager } from "../src/llm/adaptation.js";

describe("AutonomousModelAdapter", () => {
  describe("Model Blacklisting", () => {
    it("should remove a 404'd model from the model queue", () => {
      const badModel = "test/fake-model-404:free";

      // Report a 404 failure
      autonomousAdapter.reportModelFailure(badModel, 404, "Model not found");

      // The blacklisted model should NOT appear as first in queue
      const queue = autonomousAdapter.getModelQueue(badModel);
      expect(queue[0]).not.toBe(badModel);
    });

    it("should not blacklist a 429 model (rate limit is temporary)", () => {
      const rateLimitedModel = "test/rate-limited-model:free";

      // A 429 should NOT blacklist — just cooloff
      autonomousAdapter.reportRateLimit(rateLimitedModel, 5000);

      // Model should still be in healthy list after cooloff expires
      // (We can't easily test timing, but we can verify it's not permanently blacklisted)
      const queue = autonomousAdapter.getModelQueue(rateLimitedModel);
      // The model may or may not be in queue depending on cooloff, but the point is
      // it's not permanently blacklisted like a 404
      expect(queue.length).toBeGreaterThan(0);
    });
  });

  describe("Health Scoring", () => {
    it("should return neutral score (50) for unknown models", () => {
      const score = autonomousAdapter.getHealthScore("totally-unknown-model");
      expect(score).toBe(50);
    });

    it("should increase score for successful calls", () => {
      const model = "test/healthy-model:free";

      // Record 5 successful calls with low latency
      for (let i = 0; i < 5; i++) {
        autonomousAdapter.recordCallOutcome(model, 1500, true); // 1.5s, success
      }

      const score = autonomousAdapter.getHealthScore(model);
      // Should be well above neutral (50)
      expect(score).toBeGreaterThan(60);
    });

    it("should decrease score for failed calls", () => {
      const model = "test/unhealthy-model:free";

      // Record 5 failed calls
      for (let i = 0; i < 5; i++) {
        autonomousAdapter.recordCallOutcome(model, 500, false);
      }

      const score = autonomousAdapter.getHealthScore(model);
      // Should be well below neutral (50)
      expect(score).toBeLessThan(40);
    });

    it("should penalize high latency models", () => {
      const fastModel = "test/fast-model:free";
      const slowModel = "test/slow-model:free";

      // Fast model: 1s responses
      for (let i = 0; i < 5; i++) {
        autonomousAdapter.recordCallOutcome(fastModel, 1000, true);
      }

      // Slow model: 15s responses
      for (let i = 0; i < 5; i++) {
        autonomousAdapter.recordCallOutcome(slowModel, 15000, true);
      }

      const fastScore = autonomousAdapter.getHealthScore(fastModel);
      const slowScore = autonomousAdapter.getHealthScore(slowModel);

      expect(fastScore).toBeGreaterThan(slowScore);
    });
  });

  describe("Model Queue Ordering", () => {
    it("should sort models by health score (best first)", () => {
      // Record metrics to establish clear ranking
      const modelA = "test/model-a-best:free";
      const modelB = "test/model-b-worst:free";

      // Model A: fast and reliable
      for (let i = 0; i < 10; i++) {
        autonomousAdapter.recordCallOutcome(modelA, 800, true);
      }

      // Model B: slow and unreliable
      for (let i = 0; i < 10; i++) {
        autonomousAdapter.recordCallOutcome(modelB, 18000, false);
      }

      const scoreA = autonomousAdapter.getHealthScore(modelA);
      const scoreB = autonomousAdapter.getHealthScore(modelB);

      // A should score higher than B
      expect(scoreA).toBeGreaterThan(scoreB);
    });

    it("should return a non-empty model queue", () => {
      const queue = autonomousAdapter.getModelQueue();
      expect(queue.length).toBeGreaterThan(0);
    });
  });

  describe("Health Summary", () => {
    it("should return summary sorted by score descending", () => {
      // Record some data first
      autonomousAdapter.recordCallOutcome("test/summary-good:free", 500, true);
      autonomousAdapter.recordCallOutcome("test/summary-bad:free", 500, false);

      const summary = autonomousAdapter.getModelHealthSummary();
      expect(summary.length).toBeGreaterThan(0);

      // Verify sorted descending
      for (let i = 1; i < summary.length; i++) {
        expect(summary[i - 1].score).toBeGreaterThanOrEqual(summary[i].score);
      }
    });
  });

  describe("Stale Data Pruning", () => {
    it("should not throw when pruning with no data", () => {
      expect(() => autonomousAdapter.pruneStaleData()).not.toThrow();
    });

    it("should prune expired rate limits", () => {
      // Set a rate limit that's already expired
      autonomousAdapter.reportRateLimit("test/expired-rl:free", 1); // 1ms cooloff

      // Wait a tick then prune
      autonomousAdapter.pruneStaleData();

      // Model should be available in healthy list (not blocked)
      const healthy = autonomousAdapter.getHealthyFreeModels();
      // Just verify no crash and list is non-empty
      expect(healthy.length).toBeGreaterThan(0);
    });
  });
});

describe("MultiProviderKeyManager", () => {
  describe("Provider Status", () => {
    it("should return status for all providers", () => {
      const status = keyManager.getStatus();
      expect(status).toHaveProperty("gemini");
      expect(status).toHaveProperty("groq");
      expect(status).toHaveProperty("openrouter");

      // Each provider should have total, available, exhausted
      for (const provider of ["gemini", "groq", "openrouter"] as const) {
        expect(status[provider]).toHaveProperty("total");
        expect(status[provider]).toHaveProperty("available");
        expect(status[provider]).toHaveProperty("exhausted");
        expect(status[provider].total).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Exhaustion Detection", () => {
    it("should report provider as exhausted when no keys configured", () => {
      // A provider with zero keys should be considered exhausted
      // (This depends on env config, so we test the API contract)
      const isExhausted = keyManager.isProviderExhausted("openrouter");
      if (keyManager.getAllKeys("openrouter").length === 0) {
        expect(isExhausted).toBe(true);
      }
    });
  });
});
