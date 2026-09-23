/** Built by Aditya Waghamare */
import type { Tool } from "./types.js";
import { executeInSandbox } from "../sandbox/execution.js";

function requireString(input: Record<string, unknown>, key: string): string {
  const val = input[key];
  if (typeof val !== "string" || !val) throw new Error(`Missing required field: ${key}`);
  return val;
}

/**
 * 🧪 Isolated Sandbox Execution Tool — safely executes code snippets or test verification
 * without risking the host PC filesystem or exposing secrets.
 */
export const runInSandbox: Tool = {
  definition: {
    name: "run_in_sandbox",
    description: "Safely execute a JavaScript / Node.js code snippet or test verification inside an isolated, quarantined sandbox. Untrusted code cannot access your PC's private files, environment secrets, or host network.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript or Node.js code snippet to execute" },
        timeout_ms: { type: "number", description: "Execution timeout in milliseconds (default: 10000ms)" },
      },
      required: ["code"],
    },
  },
  async execute(input) {
    const code = requireString(input, "code");
    const timeoutMs = typeof input.timeout_ms === "number" ? Math.min(input.timeout_ms, 30_000) : 10_000;

    try {
      const result = await executeInSandbox(code, {
        timeoutMs,
        maxMemoryMb: 256,
        allowNetwork: false,
      });

      const output = [
        `Sandbox Type: ${result.sandboxType}`,
        `Exit Code: ${result.exitCode}`,
        `Execution Time: ${result.executionTimeMs}ms`,
        result.stdout ? `\n--- STDOUT ---\n${result.stdout}` : "",
        result.stderr ? `\n--- STDERR ---\n${result.stderr}` : "",
      ].filter(Boolean).join("\n");

      return {
        success: result.exitCode === 0,
        data: output,
      };
    } catch (err: any) {
      return {
        success: false,
        data: `Sandbox Execution Failure: ${err.message}`,
      };
    }
  },
};
