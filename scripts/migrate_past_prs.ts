/** Built by Aditya Waghamare */
import { extractTargetFiles } from "../src/dispatch/github.js";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("❌ GITHUB_TOKEN not found in environment!");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "AgentClaw-PR-Migration",
};

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubFetch(url: string, options: RequestInit = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });
  return res;
}

interface PRSearchResult {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  pull_request?: {
    url: string;
  };
}

async function fetchAllTargetPRs(): Promise<PRSearchResult[]> {
  console.log("🔍 Searching for open PRs authored by adityawaghamare04 with SOLUTION_ISSUE...");
  const prs: PRSearchResult[] = [];
  let page = 1;

  while (page <= 5) {
    const q = encodeURIComponent(`is:pr is:open author:adityawaghamare04 SOLUTION_ISSUE in:title`);
    const res = await githubFetch(`https://api.github.com/search/issues?q=${q}&per_page=100&page=${page}`);
    if (!res.ok) {
      console.error(`Search failed with status ${res.status}: ${await res.text()}`);
      break;
    }
    const data = (await res.json()) as any;
    const items = data.items || [];
    prs.push(...items);
    console.log(`Page ${page}: found ${items.length} PRs (Total so far: ${prs.length}/${data.total_count})`);
    if (items.length < 100 || prs.length >= data.total_count) break;
    page++;
    await sleep(1000);
  }

  return prs;
}

async function migrateSinglePR(prItem: PRSearchResult, index: number, total: number) {
  console.log(`\n================================================================`);
  console.log(`[${index + 1}/${total}] Processing PR #${prItem.number}: ${prItem.title}`);
  console.log(`URL: ${prItem.html_url}`);

  // Extract upstream repo owner and repo name from repository_url
  // e.g. https://api.github.com/repos/zhangjiayang6835-cyber/bounty-plaza
  const repoMatch = prItem.repository_url.match(/repos\/([^\/]+)\/([^\/]+)$/);
  if (!repoMatch) {
    console.warn(`⚠️ Could not parse repo from ${prItem.repository_url}`);
    return;
  }
  const upstreamOwner = repoMatch[1];
  const upstreamRepo = repoMatch[2];

  // 1. Get full PR details
  const prRes = await githubFetch(`https://api.github.com/repos/${upstreamOwner}/${upstreamRepo}/pulls/${prItem.number}`);
  if (!prRes.ok) {
    console.error(`❌ Failed to fetch PR details: ${prRes.status}`);
    return;
  }
  const prData = (await prRes.json()) as any;
  const headOwner = prData.head?.repo?.owner?.login;
  const headRepo = prData.head?.repo?.name;
  const branchName = prData.head?.ref;
  const headSha = prData.head?.sha;
  const baseSha = prData.base?.sha;

  if (!headOwner || !headRepo || !branchName || !headSha) {
    console.warn(`⚠️ Missing head repo or branch information for PR #${prItem.number}`);
    return;
  }

  // 2. Fetch files in PR
  const filesRes = await githubFetch(`https://api.github.com/repos/${upstreamOwner}/${upstreamRepo}/pulls/${prItem.number}/files`);
  if (!filesRes.ok) {
    console.error(`❌ Failed to fetch files for PR #${prItem.number}: ${filesRes.status}`);
    return;
  }
  const files = (await filesRes.json()) as any[];
  const mdFile = files.find((f) => /SOLUTION_ISSUE_\d+\.md$/i.test(f.filename));

  if (!mdFile) {
    console.log(`ℹ️ No SOLUTION_ISSUE_*.md found in files. Current files: ${files.map((f) => f.filename).join(", ")}`);
    return;
  }

  console.log(`📄 Found solution markdown file: ${mdFile.filename}`);

  // 3. Download raw markdown content
  const mdRes = await githubFetch(mdFile.raw_url);
  if (!mdRes.ok) {
    console.error(`❌ Failed to fetch raw content for ${mdFile.filename}: ${mdRes.status}`);
    return;
  }
  const mdContent = await mdRes.text();

  // 4. Fetch repo tree for accurate matching
  let repoTree: string[] = [];
  try {
    const treeRes = await githubFetch(`https://api.github.com/repos/${upstreamOwner}/${upstreamRepo}/git/trees/${baseSha}?recursive=1`);
    if (treeRes.ok) {
      const treeData = (await treeRes.json()) as any;
      repoTree = (treeData.tree || []).map((t: any) => t.path);
    }
  } catch (e) {
    // Ignore tree fetch failure, fallback to heuristic matching
  }

  // 5. Extract target real files
  const extractedFiles = extractTargetFiles(mdContent, prData.body || "", repoTree);
  if (!extractedFiles || extractedFiles.length === 0) {
    console.warn(`⚠️ Could not extract real target files from ${mdFile.filename}`);
    return;
  }

  console.log(`🎯 Extracted target file(s):`);
  for (const f of extractedFiles) {
    console.log(`   -> ${f.path} (${f.content.length} bytes)`);
  }

  // 6. Get current branch ref commit & tree SHA on the head repo
  const refRes = await githubFetch(`https://api.github.com/repos/${headOwner}/${headRepo}/git/ref/heads/${branchName}`);
  if (!refRes.ok) {
    console.error(`❌ Failed to get head ref ${branchName} on ${headOwner}/${headRepo}: ${refRes.status}`);
    return;
  }
  const refData = (await refRes.json()) as any;
  const currentCommitSha = refData.object.sha;

  const commitRes = await githubFetch(`https://api.github.com/repos/${headOwner}/${headRepo}/git/commits/${currentCommitSha}`);
  if (!commitRes.ok) {
    console.error(`❌ Failed to get commit ${currentCommitSha}: ${commitRes.status}`);
    return;
  }
  const commitData = (await commitRes.json()) as any;
  const currentTreeSha = commitData.tree.sha;

  // 7. Create blobs for the new target files
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string | null }> = [
    // Delete the old markdown file
    {
      path: mdFile.filename,
      mode: "100644",
      type: "blob",
      sha: null,
    },
  ];

  for (const file of extractedFiles) {
    const blobRes = await githubFetch(`https://api.github.com/repos/${headOwner}/${headRepo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: Buffer.from(file.content, "utf-8").toString("base64"),
        encoding: "base64",
      }),
    });

    if (!blobRes.ok) {
      console.error(`❌ Failed to create blob for ${file.path}: ${blobRes.status} ${await blobRes.text()}`);
      return;
    }

    const blobData = (await blobRes.json()) as any;
    treeItems.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blobData.sha,
    });
  }

  // 8. Create new tree based on currentTreeSha
  const newTreeRes = await githubFetch(`https://api.github.com/repos/${headOwner}/${headRepo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: currentTreeSha,
      tree: treeItems,
    }),
  });

  if (!newTreeRes.ok) {
    console.error(`❌ Failed to create new tree: ${newTreeRes.status} ${await newTreeRes.text()}`);
    return;
  }
  const newTreeData = (await newTreeRes.json()) as any;
  const newTreeSha = newTreeData.sha;

  // 9. Extract issue number from branch name or PR title
  const issueMatch = branchName.match(/issue-(\d+)/i) || prItem.title.match(/#(\d+)/);
  const issueNum = issueMatch ? issueMatch[1] : "";
  const mainTarget = extractedFiles[0].path;
  const commitMsg = `fix: update ${mainTarget} directly for issue #${issueNum}`;

  // 10. Create new commit
  const newCommitRes = await githubFetch(`https://api.github.com/repos/${headOwner}/${headRepo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: commitMsg,
      tree: newTreeSha,
      parents: [currentCommitSha],
    }),
  });

  if (!newCommitRes.ok) {
    console.error(`❌ Failed to create commit: ${newCommitRes.status} ${await newCommitRes.text()}`);
    return;
  }
  const newCommitData = (await newCommitRes.json()) as any;
  const newCommitSha = newCommitData.sha;

  // 11. Update branch ref
  const updateRefRes = await githubFetch(`https://api.github.com/repos/${headOwner}/${headRepo}/git/refs/heads/${branchName}`, {
    method: "PATCH",
    body: JSON.stringify({
      sha: newCommitSha,
      force: true,
    }),
  });

  if (!updateRefRes.ok) {
    console.error(`❌ Failed to update ref: ${updateRefRes.status} ${await updateRefRes.text()}`);
    return;
  }

  // 12. Update PR title on upstream repo
  const newTitle = `fix: update ${mainTarget} for issue #${issueNum}`;
  const updatePrRes = await githubFetch(`https://api.github.com/repos/${upstreamOwner}/${upstreamRepo}/pulls/${prItem.number}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: newTitle,
    }),
  });

  if (updatePrRes.ok) {
    console.log(`✅ SUCCESS: PR #${prItem.number} updated!`);
    console.log(`   Deleted: ${mdFile.filename}`);
    console.log(`   Added:   ${mainTarget}`);
    console.log(`   Title:   "${newTitle}"`);
  } else {
    console.log(`✅ Branch updated with ${mainTarget}, but title update returned ${updatePrRes.status}`);
  }
}

async function main() {
  console.log("🚀 Starting migration of past PRs to real codebase files...");
  const prs = await fetchAllTargetPRs();
  console.log(`Found total ${prs.length} candidate PRs to inspect and migrate.`);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < prs.length; i++) {
    try {
      await migrateSinglePR(prs[i], i, prs.length);
      succeeded++;
    } catch (err: any) {
      console.error(`❌ Error migrating PR #${prs[i].number}:`, err?.message || err);
      failed++;
    }
    // Rate limit safety
    await sleep(2000);
  }

  console.log(`\n🎉 Migration Complete! Successfully processed ${succeeded} PRs (${failed} failed).`);
}

main().catch(console.error);
