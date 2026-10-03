import { describe, it, expect } from "vitest";
import {
  extractTargetFiles,
  resolveFilePathAgainstTree,
  normalizeRepoPath,
  sanitizeCodeContent,
  parseHumanPrContent,
} from "../src/dispatch/github.js";

describe("GitHub Dispatcher - Path Resolution & Tree Matching", () => {
  const sampleTree = [
    "README.md",
    "package.json",
    "src/index.ts",
    "src/types/state.ts",
    "pkg/auth/keyring.go",
    "internal/git/worktree.go",
    "contracts/Escrow.sol",
  ];

  it("should match exact paths", () => {
    expect(resolveFilePathAgainstTree("src/index.ts", sampleTree)).toBe("src/index.ts");
    expect(resolveFilePathAgainstTree("contracts/Escrow.sol", sampleTree)).toBe("contracts/Escrow.sol");
  });

  it("should fuzzy-match basename to real repo path", () => {
    expect(resolveFilePathAgainstTree("worktree.go", sampleTree)).toBe("internal/git/worktree.go");
    expect(resolveFilePathAgainstTree("keyring.go", sampleTree)).toBe("pkg/auth/keyring.go");
    expect(resolveFilePathAgainstTree("state.ts", sampleTree)).toBe("src/types/state.ts");
  });

  it("should handle Windows backslashes in candidate path", () => {
    expect(resolveFilePathAgainstTree("src\\types\\state.ts", sampleTree)).toBe("src/types/state.ts");
  });

  it("should preserve new file paths not in tree for creation", () => {
    expect(resolveFilePathAgainstTree("src/utils/helpers.ts", sampleTree)).toBe("src/utils/helpers.ts");
    expect(resolveFilePathAgainstTree("pkg/newfeature/feature.go", sampleTree)).toBe("pkg/newfeature/feature.go");
  });
});

describe("GitHub Dispatcher - Target File Extraction & Code Sanitization", () => {
  const sampleTree = [
    "README.md",
    "src/index.ts",
    "src/types/state.ts",
    "internal/git/worktree.go",
  ];

  it("should extract single target file with explicit Target File header", () => {
    const solution = `
## 🛠️ Proposed Solution (by Aditya Waghamare)

### Analysis
Fixes the case-insensitive path comparison.

### Target File: \`internal/git/worktree.go\`
\`\`\`go
package git

func Status() error {
    return nil
}
\`\`\`

### Testing
Ran unit tests.
`;

    const files = extractTargetFiles(solution, "Issue #1", sampleTree);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("internal/git/worktree.go");
    expect(files[0].content).toContain("package git");
    expect(files[0].content).not.toContain("```");
    expect(files[0].content).not.toContain("## 🛠️ Proposed Solution");
  });

  it("should extract multiple target files in a single solution", () => {
    const solution = `
### Target File: \`src/index.ts\`
\`\`\`ts
export const version = "1.0.0";
\`\`\`

### Target File: \`src/types/state.ts\`
\`\`\`ts
export type AppState = { running: boolean };
\`\`\`
`;

    const files = extractTargetFiles(solution, "Issue #2", sampleTree);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("src/index.ts");
    expect(files[0].content).toBe('export const version = "1.0.0";\n');
    expect(files[1].path).toBe("src/types/state.ts");
    expect(files[1].content).toBe("export type AppState = { running: boolean };\n");
  });

  it("should fuzzy-match basename when LLM specifies only filename", () => {
    const solution = `
### Target File: \`worktree.go\`
\`\`\`go
package git
func Fix() {}
\`\`\`
`;

    const files = extractTargetFiles(solution, "Issue #3", sampleTree);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("internal/git/worktree.go");
  });

  it("should handle new file creation properly", () => {
    const solution = `
### Target File: \`src/features/auth.ts\`
\`\`\`ts
export function login() { return true; }
\`\`\`
`;

    const files = extractTargetFiles(solution, "Issue #4", sampleTree);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/features/auth.ts");
    expect(files[0].content).toContain("export function login()");
  });

  it("should NEVER create SOLUTION_ISSUE_*.md files", () => {
    const solution = `
## 🛠️ Proposed Solution (by Aditya Waghamare)

### Analysis
Here is the fix for the memory problem.

### Implementation
\`\`\`ts
export const memoryGuard = () => {};
\`\`\`
`;

    const files = extractTargetFiles(solution, "Error in state.ts", sampleTree);
    expect(files).toHaveLength(1);
    expect(files[0].path).not.toContain("SOLUTION_ISSUE");
    expect(files[0].path).not.toContain(".md");
    expect(files[0].path).toBe("src/types/state.ts");
  });
});

describe("GitHub Dispatcher - Humanized Output & PR Content", () => {
  it("should extract natural human PR title and clean narrative body without code blocks", () => {
    const rawSolution = `Title: fix(auth): prevent crash on expired session token

Took a look at this — noticed that when a session expired, verifySession() was accessing userId before checking if decode was null.

Added an early guard check so it cleanly returns 401. Also added a regression test to cover expired sessions.

Tested locally with npm test and all suites pass.

### Target File: src/auth.ts
\`\`\`ts
export function verifySession(token: string) {
  if (!token) return null;
  return { id: "123" };
}
\`\`\`
`;

    const targetFiles = [{ path: "src/auth.ts", content: "..." }];
    const parsed = parseHumanPrContent(rawSolution, "42", targetFiles);

    expect(parsed.title).toBe("fix(auth): prevent crash on expired session token");
    expect(parsed.prBody).toContain("Closes #42");
    expect(parsed.prBody).toContain("verifySession() was accessing userId");
    expect(parsed.prBody).toContain("Added an early guard check");
    expect(parsed.prBody).not.toContain("```");
    expect(parsed.prBody).not.toContain("export function");
    expect(parsed.prBody).not.toContain("### Target File");
    expect(parsed.prBody).not.toContain("💰");
    expect(parsed.prBody).not.toContain("Payout Address");
  });

  it("should generate a friendly human issue comment referencing PR without crypto spam", () => {
    const rawSolution = `
Took a look at this — traced the issue to a missing null guard in auth middleware.

Added a quick check and tested locally.

### Target File: src/middleware/auth.ts
\`\`\`ts
export const auth = () => {};
\`\`\`
`;

    const targetFiles = [{ path: "src/middleware/auth.ts", content: "..." }];
    const prUrl = "https://github.com/org/repo/pull/99";
    const parsed = parseHumanPrContent(rawSolution, "84", targetFiles, prUrl);

    expect(parsed.commentBody).toContain("Just put up a PR for this in #99 (https://github.com/org/repo/pull/99)");
    expect(parsed.commentBody).toContain("missing null guard in auth middleware");
    expect(parsed.commentBody).toContain("happy to adjust");
    expect(parsed.commentBody).not.toContain("```");
    expect(parsed.commentBody).not.toContain("💰");
    expect(parsed.commentBody).not.toContain("Payout Address");
    expect(parsed.commentBody).not.toContain("### 🔀 Pull Request Created");
  });
});

