/** Built by Aditya Waghamare */
import { createClient } from "@libsql/client";

async function main() {
  const token = process.env.GITHUB_TOKEN;
  console.log("--- 1. Testing GitHub API Status ---");
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: "Bearer " + token,
      "User-Agent": "AgentClaw",
    },
  });

  console.log("GitHub Status Code:", userRes.status, userRes.statusText);
  if (userRes.ok) {
    const userData = (await userRes.json()) as any;
    console.log("✅ Authenticated GitHub User:", userData.login);
    console.log("   Name:", userData.name);
    console.log("   Public Repos:", userData.public_repos);
    console.log("   Scopes:", userRes.headers.get("x-oauth-scopes"));
    console.log("   Rate Limit Remaining:", userRes.headers.get("x-ratelimit-remaining"), "/", userRes.headers.get("x-ratelimit-limit"));
  } else {
    console.error("❌ GitHub Error:", await userRes.text());
  }

  console.log("\n--- 2. Checking Turso DB Submitted Tasks ---");
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (!tursoUrl) {
    console.log("No TURSO_DATABASE_URL found.");
    return;
  }
  const client = createClient({ url: tursoUrl, authToken: tursoToken });
  const countRes = await client.execute("SELECT count(*) as cnt FROM tasks WHERE status = 'submitted'");
  console.log("Total submitted tasks in Turso DB:", countRes.rows[0].cnt);

  const eventRes = await client.execute("SELECT taskId, message FROM events WHERE message LIKE '%pull%' OR message LIKE '%PR%' LIMIT 10");
  console.log("Found PR events in events table:", eventRes.rows.length);
  for (const ev of eventRes.rows) {
    console.log(`- [${ev.taskId}] ${ev.message}`);
  }
}

main().catch(console.error);
