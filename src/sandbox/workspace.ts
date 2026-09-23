/** Built by Aditya Waghamare */
import fs from "node:fs/promises";
import path from "node:path";

export interface SandboxWorkspace {
  taskId: string;
  directory: string;
  createdAt: number;
}

const SANDBOX_BASE_DIR = path.resolve(process.cwd(), "data", "sandbox", "workspaces");

/**
 * Creates an isolated, quarantined workspace directory for a specific task.
 * The workspace is strictly separated from the project source code and user home directory.
 */
export async function createSandboxWorkspace(taskId: string): Promise<SandboxWorkspace> {
  const sanitizedTaskId = taskId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const workspaceDir = path.join(SANDBOX_BASE_DIR, sanitizedTaskId);

  await fs.mkdir(workspaceDir, { recursive: true });

  // Add .gitignore to ensure quarantined files are never tracked in Git
  const gitignorePath = path.join(workspaceDir, ".gitignore");
  await fs.writeFile(gitignorePath, "*\n!.gitignore\n", "utf8");

  return {
    taskId: sanitizedTaskId,
    directory: workspaceDir,
    createdAt: Date.now(),
  };
}

/**
 * Recursively cleans up and completely destroys the quarantined sandbox workspace.
 * Ensures zero leftover 3rd-party files remain on disk.
 */
export async function cleanupSandboxWorkspace(taskId: string): Promise<void> {
  const sanitizedTaskId = taskId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const workspaceDir = path.join(SANDBOX_BASE_DIR, sanitizedTaskId);

  try {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  } catch (err: any) {
    console.warn(`[Sandbox Workspace] Warning cleaning up ${workspaceDir}: ${err.message}`);
  }
}

/**
 * Cleans up all stale sandbox workspaces older than maxAgeMs (default 1 hour).
 */
export async function purgeAllStaleSandboxes(maxAgeMs: number = 60 * 60 * 1000): Promise<number> {
  let cleanedCount = 0;
  try {
    const entries = await fs.readdir(SANDBOX_BASE_DIR, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(SANDBOX_BASE_DIR, entry.name);
        try {
          const stats = await fs.stat(fullPath);
          if (now - stats.mtimeMs > maxAgeMs) {
            await fs.rm(fullPath, { recursive: true, force: true });
            cleanedCount++;
          }
        } catch {}
      }
    }
  } catch {
    // Base dir may not exist yet, which is safe
  }
  return cleanedCount;
}

/**
 * Downloads repository source files into the isolated quarantine sandbox directory via GitHub API.
 * Never executes git hooks, post-install scripts, or binaries on the host system.
 */
export async function fetchRepoIntoSandbox(
  owner: string,
  repo: string,
  workspace: SandboxWorkspace,
  filesToFetch?: string[]
): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    "User-Agent": "AgentClaw-Sandbox",
    "Accept": "application/vnd.github.v3+json",
    ...(token ? { Authorization: `token ${token}` } : {}),
  };

  const fetchedFiles: string[] = [];

  let targetPaths: string[] = filesToFetch || [];
  if (targetPaths.length === 0) {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) return [];
    const repoData = (await repoRes.json()) as any;
    const defaultBranch = repoData.default_branch || "main";

    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      { headers }
    );
    if (!treeRes.ok) return [];
    const treeData = (await treeRes.json()) as any;
    targetPaths = (treeData.tree || [])
      .filter((n: any) => n.type === "blob")
      .map((n: any) => n.path as string)
      .slice(0, 30); // Cap at 30 critical files to conserve bandwidth & disk
  }

  for (const filePath of targetPaths) {
    try {
      const fileRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
        { headers }
      );
      if (fileRes.ok) {
        const fileData = (await fileRes.json()) as any;
        if (fileData.type === "file" && fileData.content) {
          const content = Buffer.from(fileData.content, "base64");
          const localPath = path.join(workspace.directory, filePath);
          await fs.mkdir(path.dirname(localPath), { recursive: true });
          await fs.writeFile(localPath, content);
          fetchedFiles.push(filePath);
        }
      }
    } catch {}
  }

  return fetchedFiles;
}
