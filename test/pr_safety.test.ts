/** Built by Aditya Waghamare */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prSafetyGuard } from "../src/security/pr_safety.js";

describe("prSafetyGuard (GitHub Anti-Spam & Rate Limiter)", () => {
  beforeEach(() => {
    prSafetyGuard._resetForTest();
    process.env.MAX_DAILY_PRS = "5";
    process.env.HOURLY_PR_BURST_LIMIT = "3";
    process.env.PR_COOLDOWN_SECONDS = "10";
    process.env.MAX_PRS_PER_REPO_DAILY = "2";
  });

  afterEach(() => {
    prSafetyGuard._resetForTest();
  });

  it("allows the initial PR dispatch", () => {
    const check = prSafetyGuard.canDispatchPr("test-owner/test-repo", "https://github.com/test-owner/test-repo/issues/1");
    expect(check.allowed).toBe(true);
    expect(check.stats?.dailyCount).toBe(0);
  });

  it("blocks rapid back-to-back PRs with cooldown", () => {
    prSafetyGuard.recordPrDispatch("test-owner/repo-a", "https://github.com/test-owner/repo-a/pull/1", "https://github.com/test-owner/repo-a/issues/1");
    
    // Immediate attempt should fail cooldown check
    const check = prSafetyGuard.canDispatchPr("test-owner/repo-b", "https://github.com/test-owner/repo-b/issues/2");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("Cooldown active");
    expect(check.waitSeconds).toBeGreaterThan(0);
  });

  it("enforces per-repository daily limit", () => {
    process.env.PR_COOLDOWN_SECONDS = "0"; // Disable cooldown to test per-repo limit

    prSafetyGuard.recordPrDispatch("acme/widgets", "https://github.com/acme/widgets/pull/1", "https://github.com/acme/widgets/issues/1");
    prSafetyGuard.recordPrDispatch("acme/widgets", "https://github.com/acme/widgets/pull/2", "https://github.com/acme/widgets/issues/2");

    // 3rd attempt on same repo should be blocked
    const sameRepoCheck = prSafetyGuard.canDispatchPr("acme/widgets", "https://github.com/acme/widgets/issues/3");
    expect(sameRepoCheck.allowed).toBe(false);
    expect(sameRepoCheck.reason).toContain("Repository limit reached for acme/widgets");

    // Different repo should still be allowed
    const differentRepoCheck = prSafetyGuard.canDispatchPr("other/repo", "https://github.com/other/repo/issues/1");
    expect(differentRepoCheck.allowed).toBe(true);
  });

  it("enforces global daily PR limit", () => {
    process.env.PR_COOLDOWN_SECONDS = "0";
    process.env.HOURLY_PR_BURST_LIMIT = "100";
    process.env.MAX_PRS_PER_REPO_DAILY = "100";
    process.env.MAX_DAILY_PRS = "3";

    prSafetyGuard.recordPrDispatch("owner/repo1", "https://github.com/owner/repo1/pull/1", "https://github.com/owner/repo1/issues/1");
    prSafetyGuard.recordPrDispatch("owner/repo2", "https://github.com/owner/repo2/pull/1", "https://github.com/owner/repo2/issues/1");
    prSafetyGuard.recordPrDispatch("owner/repo3", "https://github.com/owner/repo3/pull/1", "https://github.com/owner/repo3/issues/1");

    // 4th dispatch exceeds daily limit of 3
    const check = prSafetyGuard.canDispatchPr("owner/repo4", "https://github.com/owner/repo4/issues/1");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("Daily PR limit reached");
  });
});
