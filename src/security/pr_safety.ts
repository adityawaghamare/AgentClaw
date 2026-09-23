/** Built by Aditya Waghamare */
import fs from "node:fs";
import path from "node:path";
import { appendLog } from "../memory/log.js";

export interface PrDispatchRecord {
  timestamp: number;
  repo: string; // e.g. "owner/repo"
  prUrl?: string;
  issueUrl: string;
}

export interface PrSafetyCheckResult {
  allowed: boolean;
  reason?: string;
  waitSeconds?: number;
  stats?: {
    dailyCount: number;
    dailyLimit: number;
    hourlyCount: number;
    hourlyLimit: number;
    repoDailyCount: number;
    repoDailyLimit: number;
    cooldownRemainingSeconds: number;
  };
}

class PrSafetyGuard {
  private logPath: string;
  private records: PrDispatchRecord[] = [];
  private isLoaded = false;

  constructor() {
    this.logPath = path.join(process.cwd(), "data", "pr_safety_log.json");
    this.load();
  }

  private getMaxDailyPrs(): number {
    return parseInt(process.env.MAX_DAILY_PRS || "35", 10);
  }

  private getHourlyBurstLimit(): number {
    return parseInt(process.env.HOURLY_PR_BURST_LIMIT || "6", 10);
  }

  private getPrCooldownSeconds(): number {
    return parseInt(process.env.PR_COOLDOWN_SECONDS || "300", 10); // 5 minutes
  }

  private getMaxPrsPerRepoDaily(): number {
    return parseInt(process.env.MAX_PRS_PER_REPO_DAILY || "2", 10);
  }

  private load(): void {
    try {
      if (fs.existsSync(this.logPath)) {
        const raw = fs.readFileSync(this.logPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Keep records from last 48 hours only
          const cutoff = Date.now() - 48 * 60 * 60 * 1000;
          this.records = parsed.filter((r) => r && r.timestamp && r.timestamp > cutoff);
        }
      }
    } catch {
      this.records = [];
    }
    this.isLoaded = true;
  }

  private save(): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.logPath, JSON.stringify(this.records, null, 2), "utf-8");
    } catch (err: any) {
      console.warn("[Anti-Spam Guard] Failed to persist safety log:", err.message);
    }
  }

  /**
   * Evaluates if a new Pull Request is allowed to be dispatched according to anti-spam rules.
   */
  public canDispatchPr(repo: string, issueUrl: string): PrSafetyCheckResult {
    if (!this.isLoaded) this.load();

    const now = Date.now();
    const maxDaily = this.getMaxDailyPrs();
    const maxHourly = this.getHourlyBurstLimit();
    const cooldownSeconds = this.getPrCooldownSeconds();
    const maxPerRepo = this.getMaxPrsPerRepoDaily();

    const normRepo = repo.toLowerCase().trim();

    // 1. Cooldown Check (Spaced out submissions)
    const sorted = [...this.records].sort((a, b) => b.timestamp - a.timestamp);
    const lastRecord = sorted[0];
    let cooldownRemaining = 0;
    if (lastRecord) {
      const elapsedSeconds = Math.floor((now - lastRecord.timestamp) / 1000);
      if (elapsedSeconds < cooldownSeconds) {
        cooldownRemaining = cooldownSeconds - elapsedSeconds;
        const msg = `Cooldown active. Last PR was created ${elapsedSeconds}s ago. Waiting ${cooldownRemaining}s before next PR to avoid GitHub spam triggers.`;
        return {
          allowed: false,
          reason: msg,
          waitSeconds: cooldownRemaining,
          stats: {
            dailyCount: this.get24hCount(),
            dailyLimit: maxDaily,
            hourlyCount: this.get1hCount(),
            hourlyLimit: maxHourly,
            repoDailyCount: this.getRepo24hCount(normRepo),
            repoDailyLimit: maxPerRepo,
            cooldownRemainingSeconds: cooldownRemaining,
          },
        };
      }
    }

    // 2. Hourly Burst Limit Check (Max 6 / hour)
    const hourlyCount = this.get1hCount();
    if (hourlyCount >= maxHourly) {
      const msg = `Hourly PR limit reached (${hourlyCount}/${maxHourly}). Pausing to prevent rate-limit bans.`;
      return {
        allowed: false,
        reason: msg,
        waitSeconds: 600,
        stats: {
          dailyCount: this.get24hCount(),
          dailyLimit: maxDaily,
          hourlyCount,
          hourlyLimit: maxHourly,
          repoDailyCount: this.getRepo24hCount(normRepo),
          repoDailyLimit: maxPerRepo,
          cooldownRemainingSeconds: 0,
        },
      };
    }

    // 3. Daily 24h Limit Check (Max 35 / day)
    const dailyCount = this.get24hCount();
    if (dailyCount >= maxDaily) {
      const msg = `Daily PR limit reached (${dailyCount}/${maxDaily}). Halting further automated PRs for 24h to keep GitHub account in good standing.`;
      return {
        allowed: false,
        reason: msg,
        waitSeconds: 3600,
        stats: {
          dailyCount,
          dailyLimit: maxDaily,
          hourlyCount,
          hourlyLimit: maxHourly,
          repoDailyCount: this.getRepo24hCount(normRepo),
          repoDailyLimit: maxPerRepo,
          cooldownRemainingSeconds: 0,
        },
      };
    }

    // 4. Per-Repository Daily Limit Check (Max 2 PRs per repo / day)
    const repoDailyCount = this.getRepo24hCount(normRepo);
    if (repoDailyCount >= maxPerRepo) {
      const msg = `Repository limit reached for ${repo} (${repoDailyCount}/${maxPerRepo} today). Skipping PR to avoid spamming maintainers.`;
      return {
        allowed: false,
        reason: msg,
        stats: {
          dailyCount,
          dailyLimit: maxDaily,
          hourlyCount,
          hourlyLimit: maxHourly,
          repoDailyCount,
          repoDailyLimit: maxPerRepo,
          cooldownRemainingSeconds: 0,
        },
      };
    }

    return {
      allowed: true,
      stats: {
        dailyCount,
        dailyLimit: maxDaily,
        hourlyCount,
        hourlyLimit: maxHourly,
        repoDailyCount,
        repoDailyLimit: maxPerRepo,
        cooldownRemainingSeconds: 0,
      },
    };
  }

  /**
   * Records a successful PR dispatch
   */
  public recordPrDispatch(repo: string, prUrl?: string, issueUrl: string = ""): void {
    const record: PrDispatchRecord = {
      timestamp: Date.now(),
      repo: repo.toLowerCase().trim(),
      prUrl,
      issueUrl,
    };
    this.records.push(record);
    this.save();

    const logMsg = `🛡️ [Anti-Spam Guard] PR recorded for ${repo}. Daily count: ${this.get24hCount()}/${this.getMaxDailyPrs()}. Next PR cooldown: ${this.getPrCooldownSeconds()}s.`;
    console.log(logMsg);
    appendLog(logMsg);
  }

  public get24hCount(): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.records.filter((r) => r.timestamp > cutoff).length;
  }

  public get1hCount(): number {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this.records.filter((r) => r.timestamp > cutoff).length;
  }

  public getRepo24hCount(repo: string): number {
    const norm = repo.toLowerCase().trim();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.records.filter((r) => r.repo === norm && r.timestamp > cutoff).length;
  }

  /**
   * Clears records (useful for testing)
   */
  public _resetForTest(): void {
    this.records = [];
    this.save();
  }
}

export const prSafetyGuard = new PrSafetyGuard();
