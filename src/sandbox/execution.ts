/** Built by Aditya Waghamare */
import { exec, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SandboxOptions {
  timeoutMs?: number;
  maxMemoryMb?: number;
  allowNetwork?: boolean;
  env?: Record<string, string>;
  workDir?: string;
}

export interface SandboxResult {
  sandboxType: "docker" | "restricted_vm";
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}

const SANDBOX_TMP_DIR = path.resolve(process.cwd(), "data", "sandbox", "tmp");

if (!fs.existsSync(SANDBOX_TMP_DIR)) {
  fs.mkdirSync(SANDBOX_TMP_DIR, { recursive: true });
}

let isDockerAvailableCache: boolean | null = null;

export async function checkDockerAvailable(): Promise<boolean> {
  if (isDockerAvailableCache !== null) return isDockerAvailableCache;
  return new Promise((resolve) => {
    exec("docker info", { timeout: 3000 }, (error) => {
      isDockerAvailableCache = !error;
      resolve(isDockerAvailableCache);
    });
  });
}

/**
 * Sanitizes environment variables to prevent leakage of secrets to untrusted sandboxed tasks.
 * Strips all tokens, private keys, passwords, database credentials, and webhook URLs.
 */
export function getSanitizedEnv(customEnv?: Record<string, string>): Record<string, string> {
  const safeEnv: Record<string, string> = {
    PATH: process.env.PATH || "",
    NODE_ENV: "production",
    TEMP: SANDBOX_TMP_DIR,
    TMP: SANDBOX_TMP_DIR,
  };

  // Only pass non-sensitive system environment variables
  const SENSITIVE_PATTERNS = [
    /TOKEN/i,
    /KEY/i,
    /SECRET/i,
    /PASSWORD/i,
    /PASSPHRASE/i,
    /AUTH/i,
    /DATABASE/i,
    /PRIVATE/i,
    /WEBHOOK/i,
    /ADMIN/i,
    /CREDENTIAL/i,
    /BEARER/i,
    /URL/i,
  ];

  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    const isSensitive = SENSITIVE_PATTERNS.some((p) => p.test(k));
    if (!isSensitive) {
      safeEnv[k] = v;
    }
  }

  if (customEnv) {
    Object.assign(safeEnv, customEnv);
  }

  return safeEnv;
}

/**
 * Securely executes untrusted code or bash commands inside a sandbox (Docker container or Restricted Subprocess VM).
 */
export async function executeInSandbox(
  commandOrScript: string,
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs || 15_000; // 15s default
  const maxMemoryMb = options.maxMemoryMb || 256; // 256MB cap
  const allowNetwork = options.allowNetwork || false;

  const hasDocker = await checkDockerAvailable();

  if (hasDocker) {
    return runInDockerSandbox(commandOrScript, options, startTime, timeoutMs, maxMemoryMb, allowNetwork);
  } else {
    return runInRestrictedSubprocessSandbox(commandOrScript, options, startTime, timeoutMs, maxMemoryMb);
  }
}

async function runInDockerSandbox(
  command: string,
  options: SandboxOptions,
  startTime: number,
  timeoutMs: number,
  maxMemoryMb: number,
  allowNetwork: boolean
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const netFlag = allowNetwork ? "" : "--network none";
    const workDir = options.workDir || SANDBOX_TMP_DIR;
    const dockerCmd = `docker run --rm ${netFlag} --memory ${maxMemoryMb}m --cpus 1.0 -v "${workDir}:/workspace" -w /workspace node:20-alpine sh -c ${JSON.stringify(command)}`;

    exec(dockerCmd, { timeout: timeoutMs, env: getSanitizedEnv(options.env) }, (err, stdout, stderr) => {
      resolve({
        sandboxType: "docker",
        stdout: stdout ? stdout.trim() : "",
        stderr: stderr ? stderr.trim() : (err ? err.message : ""),
        exitCode: err ? (err.code || 1) : 0,
        executionTimeMs: Date.now() - startTime,
      });
    });
  });
}

async function runInRestrictedSubprocessSandbox(
  command: string,
  options: SandboxOptions,
  startTime: number,
  timeoutMs: number,
  maxMemoryMb: number
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const workDir = options.workDir || SANDBOX_TMP_DIR;
    const scriptId = `sandbox_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.cjs`;
    const scriptPath = path.join(workDir, scriptId);

    // Isolate execution inside an evaluation wrapper with filesystem & module guards
    const safeWrapperCode = `
      // Quarantined Sandbox Isolation Wrapper
      const path = require("node:path");
      const Module = require("node:module");

      // 1. Module Access Guard — block process execution and threading modules
      const blockedModules = new Set([
        "child_process", "node:child_process",
        "cluster", "node:cluster",
        "v8", "node:v8",
        "vm", "node:vm",
        "worker_threads", "node:worker_threads"
      ]);

      const origRequire = Module.prototype.require;
      Module.prototype.require = function(id) {
        if (blockedModules.has(id)) {
          throw new Error("Access to module '" + id + "' is restricted in quarantined sandbox.");
        }
        return origRequire.apply(this, arguments);
      };

      // 2. Sensitive File Access Guard for fs
      const fs = require("node:fs");
      const sensitivePatterns = [/\\.env/i, /\\.ssh/i, /\\.cashclaw/i, /wallet\\.json/i, /vault/i, /\\.git/i];

      function assertSafePath(targetPath) {
        if (typeof targetPath !== "string") return;
        const resolved = path.resolve(targetPath);
        for (const p of sensitivePatterns) {
          if (p.test(resolved)) {
            throw new Error("Sandbox Security Violation: Access to sensitive file is prohibited.");
          }
        }
      }

      const origReadFile = fs.readFile;
      fs.readFile = function(p, ...args) { assertSafePath(p); return origReadFile.call(fs, p, ...args); };
      const origReadFileSync = fs.readFileSync;
      fs.readFileSync = function(p, ...args) { assertSafePath(p); return origReadFileSync.call(fs, p, ...args); };
      const origOpen = fs.open;
      fs.open = function(p, ...args) { assertSafePath(p); return origOpen.call(fs, p, ...args); };
      const origOpenSync = fs.openSync;
      fs.openSync = function(p, ...args) { assertSafePath(p); return origOpenSync.call(fs, p, ...args); };

      try {
        ${command.includes("console.log") || command.includes(";") || command.includes("\n") ? command : `console.log(eval(${JSON.stringify(command)}));`}
      } catch (err) {
        console.error("Sandbox Execution Error:", err && err.message ? err.message : String(err));
        process.exit(1);
      }
    `;

    try {
      fs.writeFileSync(scriptPath, safeWrapperCode, "utf8");
    } catch (err: any) {
      return resolve({
        sandboxType: "restricted_vm",
        stdout: "",
        stderr: `Failed to write sandbox script: ${err.message}`,
        exitCode: 1,
        executionTimeMs: Date.now() - startTime,
      });
    }

    const child = spawn(process.execPath, [`--max-old-space-size=${maxMemoryMb}`, scriptPath], {
      cwd: workDir,
      env: getSanitizedEnv(options.env),
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code, signal) => {
      try { fs.unlinkSync(scriptPath); } catch {}

      const isTimedOut = signal === "SIGTERM" || signal === "SIGKILL" || code === null;
      resolve({
        sandboxType: "restricted_vm",
        stdout: stdout.trim(),
        stderr: isTimedOut ? (stderr ? `${stderr}\nExecution timed out` : "Execution timed out") : stderr.trim(),
        exitCode: isTimedOut ? 1 : (code ?? 0),
        executionTimeMs: Date.now() - startTime,
      });
    });

    child.on("error", (err) => {
      try { fs.unlinkSync(scriptPath); } catch {}
      resolve({
        sandboxType: "restricted_vm",
        stdout: "",
        stderr: err.message,
        exitCode: 1,
        executionTimeMs: Date.now() - startTime,
      });
    });
  });
}
