import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createSandboxWorkspace,
  cleanupSandboxWorkspace,
  purgeAllStaleSandboxes,
} from "../src/sandbox/workspace.js";
import {
  getSanitizedEnv,
  executeInSandbox,
  checkDockerAvailable,
} from "../src/sandbox/execution.js";

describe("Sandbox Workspace Manager", () => {
  const testTaskId = "test_task_sandbox_123";

  afterEach(async () => {
    await cleanupSandboxWorkspace(testTaskId);
  });

  it("should create an isolated quarantined workspace with .gitignore", async () => {
    const ws = await createSandboxWorkspace(testTaskId);
    expect(ws.taskId).toBe(testTaskId);
    expect(ws.directory).toContain(path.join("data", "sandbox", "workspaces", testTaskId));

    // Check directory exists
    const stats = await fs.stat(ws.directory);
    expect(stats.isDirectory()).toBe(true);

    // Check .gitignore exists
    const gitignoreContent = await fs.readFile(path.join(ws.directory, ".gitignore"), "utf8");
    expect(gitignoreContent).toContain("*");
  });

  it("should completely clean up and destroy the workspace", async () => {
    const ws = await createSandboxWorkspace(testTaskId);
    await cleanupSandboxWorkspace(testTaskId);

    // Directory should no longer exist
    let exists = true;
    try {
      await fs.stat(ws.directory);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("should purge stale sandboxes older than threshold", async () => {
    const ws = await createSandboxWorkspace("stale_task_999");
    const cleaned = await purgeAllStaleSandboxes(-1000); // Threshold in the past
    expect(cleaned).toBeGreaterThanOrEqual(1);
  });
});

describe("Sandbox Execution & Secret Scrubbing", () => {
  it("should strictly scrub all sensitive tokens, keys, and passwords from env", () => {
    process.env.ETH_PRIVATE_KEY = "0x123456789abcdef";
    process.env.ADMIN_PASSWORD = "SuperSecretPassword";
    process.env.VAULT_PASSPHRASE = "TopSecretPassphrase";
    process.env.GEMINI_API_KEY = "AIzaSyTestKey";
    process.env.TURSO_AUTH_TOKEN = "jwt.token.here";
    process.env.TURSO_DATABASE_URL = "libsql://test.turso.io";
    process.env.SAFE_VAR = "hello_world";

    const sanitized = getSanitizedEnv();

    expect(sanitized.SAFE_VAR).toBe("hello_world");
    expect(sanitized.ETH_PRIVATE_KEY).toBeUndefined();
    expect(sanitized.ADMIN_PASSWORD).toBeUndefined();
    expect(sanitized.VAULT_PASSPHRASE).toBeUndefined();
    expect(sanitized.GEMINI_API_KEY).toBeUndefined();
    expect(sanitized.TURSO_AUTH_TOKEN).toBeUndefined();
    expect(sanitized.TURSO_DATABASE_URL).toBeUndefined();
  });

  it("should safely execute a JavaScript expression in the sandbox", async () => {
    const result = await executeInSandbox("1 + 1", { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2");
    expect(result.executionTimeMs).toBeGreaterThan(0);
  });

  it("should capture syntax/runtime errors cleanly without crashing host process", async () => {
    const result = await executeInSandbox("throw new Error('Explosion in sandbox')", { timeoutMs: 5000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Explosion in sandbox");
  });

  it("should enforce timeout on runaway infinite loops", async () => {
    const result = await executeInSandbox("while(true){}", { timeoutMs: 1000 });
    expect(result.exitCode).not.toBe(0);
  });
});
