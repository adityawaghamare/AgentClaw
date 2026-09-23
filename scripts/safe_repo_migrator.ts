/** Built by Aditya Waghamare */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

interface MigrationQueueItem {
  name: string;
  sourceUrl: string;
  description?: string;
  isPrivate?: boolean;
}

interface MigrationState {
  lastMigratedAt?: number;
  completed: Array<{
    name: string;
    migratedAt: number;
    targetUrl: string;
  }>;
  pending: string[];
}

const STATE_FILE = path.join(process.cwd(), "data", "migration_schedule.json");
const TEMP_DIR = path.join(process.cwd(), "data", "scratch", "migration");

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOriginalReposFromOldAccount(oldToken?: string): Promise<MigrationQueueItem[]> {
  const token = oldToken || process.env.OLD_GITHUB_TOKEN;
  if (!token) {
    console.log("ℹ️ No OLD_GITHUB_TOKEN found. Using default repository list.");
    return [];
  }

  try {
    let page = 1;
    const allRepos: any[] = [];
    while (true) {
      const res = await fetch(`https://api.github.com/user/repos?affiliation=owner&per_page=100&page=${page}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "Safe-Repo-Migrator",
        },
      });
      if (!res.ok) break;
      const repos = (await res.json()) as any[];
      if (!repos.length) break;
      allRepos.push(...repos);
      page++;
    }

    // Filter out forks, keep only original repositories and sort chronologically (oldest past work first -> newest flagship work last)
    const original = allRepos.filter((r) => !r.fork);
    original.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return original.map((r) => ({
      name: r.name,
      sourceUrl: `https://${token}@github.com/adityawaghamare04/${r.name}.git`,
      description: r.description || "",
      isPrivate: r.private || false,
    }));
  } catch (err: any) {
    console.warn("⚠️ Failed to fetch repos from old account:", err.message);
    return [];
  }
}

function loadState(availableRepos: MigrationQueueItem[]): MigrationState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      return state;
    } catch {}
  }

  return {
    completed: [
      {
        name: "adityawaghamare04",
        migratedAt: Date.now(),
        targetUrl: "https://github.com/adityawaghamare/adityawaghamare",
      },
    ],
    pending: availableRepos
      .filter((r) => r.name !== "adityawaghamare04")
      .map((r) => r.name),
  };
}

function saveState(state: MigrationState): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

async function createGitHubRepo(
  token: string,
  repoName: string,
  description: string = "",
  isPrivate: boolean = false
): Promise<boolean> {
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Safe-Repo-Migrator",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: repoName,
      description: description,
      private: isPrivate,
      auto_init: false,
    }),
  });

  if (res.status === 201 || res.status === 422) {
    return true;
  }
  console.error(`❌ Failed to create repo on GitHub (${res.status}):`, await res.text());
  return false;
}

async function migrateSingleProject(
  projectName: string,
  targetUser: string,
  token: string,
  repos: MigrationQueueItem[],
  state: MigrationState
): Promise<boolean> {
  const projectConfig = repos.find((p) => p.name.toLowerCase() === projectName.toLowerCase()) || {
    name: projectName,
    sourceUrl: `https://${process.env.OLD_GITHUB_TOKEN}@github.com/adityawaghamare04/${projectName}.git`,
    description: "",
    isPrivate: false,
  };

  console.log(`\n================================================================`);
  console.log(`🚀 Migrating: ${projectConfig.name} (${projectConfig.isPrivate ? "PRIVATE" : "PUBLIC"})...`);

  // Clean scratch directory
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const mirrorPath = path.join(TEMP_DIR, `${projectConfig.name}.git`);

  try {
    // Bare clone from old account
    console.log(`   1. Cloning mirror with full history from old account...`);
    execSync(`git clone --mirror "${projectConfig.sourceUrl}" "${mirrorPath}"`, { stdio: "inherit" });

    // Create repository on new GitHub account
    console.log(`   2. Ensuring repository ${targetUser}/${projectConfig.name} exists on GitHub...`);
    await createGitHubRepo(token, projectConfig.name, projectConfig.description, projectConfig.isPrivate);

    // Push mirror to new account
    const pushUrl = `https://${targetUser}:${token}@github.com/${targetUser}/${projectConfig.name}.git`;
    console.log(`   3. Pushing all branches, tags, and commits to @${targetUser}...`);
    execSync(`git -C "${mirrorPath}" push --mirror "${pushUrl}"`, { stdio: "inherit" });

    // Update state
    state.lastMigratedAt = Date.now();
    state.completed.push({
      name: projectConfig.name,
      migratedAt: Date.now(),
      targetUrl: `https://github.com/${targetUser}/${projectConfig.name}`,
    });

    // Remove from pending
    state.pending = state.pending.filter((p) => p.toLowerCase() !== projectConfig.name.toLowerCase());
    saveState(state);

    console.log(`✅ SUCCESS: Migrated ${projectConfig.name} -> https://github.com/${targetUser}/${projectConfig.name}`);
    return true;
  } catch (err: any) {
    console.error(`❌ Migration failed for ${projectConfig.name}:`, err.message);
    return false;
  } finally {
    try {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isForce = args.includes("--force");
  
  // Check for --repos arg
  let targetRepos: string[] = [];
  const reposIdx = args.indexOf("--repos");
  if (reposIdx !== -1 && args[reposIdx + 1]) {
    targetRepos = args[reposIdx + 1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Check for --batch <N>
  let batchCount = 1;
  const batchIdx = args.indexOf("--batch");
  if (batchIdx !== -1 && args[batchIdx + 1]) {
    batchCount = parseInt(args[batchIdx + 1], 10) || 1;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("❌ No GITHUB_TOKEN provided in .env");
    process.exit(1);
  }

  // 1. Authenticate target new account
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Safe-Repo-Migrator",
    },
  });

  if (!userRes.ok) {
    console.error(`❌ Token authentication failed (${userRes.status}):`, await userRes.text());
    process.exit(1);
  }

  const userData = (await userRes.json()) as any;
  const targetUser = userData.login;
  console.log(`🛡️ Authenticated Target Account: @${targetUser}`);

  // 2. Discover all original repos from old account
  const repos = await fetchOriginalReposFromOldAccount();
  console.log(`📦 Discovered ${repos.length} original projects on @adityawaghamare04.`);

  const state = loadState(repos);

  // If specific target repos were requested, use those
  let queueToProcess: string[] = [];
  if (targetRepos.length > 0) {
    queueToProcess = targetRepos;
    console.log(`🎯 Targeted migration for ${queueToProcess.length} repositories: ${queueToProcess.join(", ")}`);
  } else {
    // 24-hour Safe Cadence Check if not forced and no specific batch requested
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (!isForce && batchCount === 1 && state.lastMigratedAt) {
      const elapsed = Date.now() - state.lastMigratedAt;
      if (elapsed < ONE_DAY_MS) {
        const remainingHours = Math.ceil((ONE_DAY_MS - elapsed) / (60 * 60 * 1000));
        console.log(`\n⏳ [Anti-Spam Pacing Guard] Daily project migration limit reached.`);
        console.log(`   Last project migrated: ${new Date(state.lastMigratedAt).toLocaleString()}`);
        console.log(`   Next project scheduled in: ~${remainingHours} hours.`);
        console.log(`   (To migrate immediately, pass --force or --repos)`);
        console.log(`\n📊 Queue Status: ${state.completed.length} completed, ${state.pending.length} remaining.`);
        return;
      }
    }

    queueToProcess = state.pending.slice(0, batchCount);
  }

  if (queueToProcess.length === 0) {
    console.log("🎉 All personal projects have been successfully migrated!");
    return;
  }

  console.log(`\n🚀 Starting migration of ${queueToProcess.length} projects with safe pacing...`);

  let succeeded = 0;
  for (let i = 0; i < queueToProcess.length; i++) {
    const proj = queueToProcess[i];
    console.log(`\n[${i + 1}/${queueToProcess.length}] Processing ${proj}...`);
    const ok = await migrateSingleProject(proj, targetUser, token, repos, state);
    if (ok) succeeded++;

    // Safe cooldown between consecutive repos (15 seconds) to avoid GitHub burst limits
    if (i < queueToProcess.length - 1) {
      console.log(`⏳ Pacing pause (15s cooldown) before next repository...`);
      await sleep(15000);
    }
  }

  console.log(`\n================================================================`);
  console.log(`🎉 Batch Migration Complete! ${succeeded}/${queueToProcess.length} successfully migrated.`);
  console.log(`📊 Overall Status: ${state.completed.length} completed / ${state.pending.length} remaining.`);
}

main().catch(console.error);
