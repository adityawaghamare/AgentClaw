/** Built by Aditya Waghamare */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

async function setupProfile() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("❌ No GITHUB_TOKEN in environment");
    process.exit(1);
  }

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Profile-Setup-Script",
    "Content-Type": "application/json",
  };

  console.log("1. Authenticating user...");
  const userRes = await fetch("https://api.github.com/user", { headers: authHeaders });
  if (!userRes.ok) {
    console.error("❌ Failed to get user details:", await userRes.text());
    process.exit(1);
  }
  const user = (await userRes.json()) as any;
  const username = user.login; // "adityawaghamare"
  console.log(`✅ Authenticated as @${username}`);

  // 1. Create the special repository adityawaghamare/adityawaghamare
  console.log(`2. Creating special profile repository ${username}/${username}...`);
  const createRepoRes = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: username,
      description: "Aditya Waghamare — AI & Agentic Systems Architect | Web3 Developer",
      private: false,
      auto_init: true, // initializes with main branch and default README
    }),
  });

  if (createRepoRes.status === 201) {
    console.log(`✅ Special profile repository created successfully: https://github.com/${username}/${username}`);
  } else if (createRepoRes.status === 422) {
    console.log(`ℹ️ Repository https://github.com/${username}/${username} already exists.`);
  } else {
    console.error(`❌ Unexpected error creating repo (${createRepoRes.status}):`, await createRepoRes.text());
    process.exit(1);
  }

  // 2. Read the source profile README from old profile or scratch
  const sourcePath = path.join(process.cwd(), "data", "scratch", "old_profile", "README.md");
  let readmeContent = "";
  if (fs.existsSync(sourcePath)) {
    readmeContent = fs.readFileSync(sourcePath, "utf-8");
  } else {
    console.log("Cloning old profile README...");
    execSync("git clone https://github.com/adityawaghamare04/adityawaghamare04.git data/scratch/old_profile", { stdio: "inherit" });
    readmeContent = fs.readFileSync(sourcePath, "utf-8");
  }

  // 3. Update links from old username adityawaghamare04 to new username adityawaghamare
  const updatedReadme = readmeContent.replace(/adityawaghamare04/g, username);

  // 4. Update README via GitHub Contents API
  console.log(`3. Updating README.md on ${username}/${username}...`);
  
  // Get current file sha if it exists
  let existingSha: string | undefined;
  const getFileRes = await fetch(`https://api.github.com/repos/${username}/${username}/contents/README.md`, { headers: authHeaders });
  if (getFileRes.ok) {
    const fileData = (await getFileRes.json()) as any;
    existingSha = fileData.sha;
  }

  const putBody: any = {
    message: "feat: initialize profile README with dynamic badges, skills, and portfolio",
    content: Buffer.from(updatedReadme, "utf-8").toString("base64"),
  };
  if (existingSha) putBody.sha = existingSha;

  const putRes = await fetch(`https://api.github.com/repos/${username}/${username}/contents/README.md`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify(putBody),
  });

  if (putRes.ok) {
    console.log(`🎉 SUCCESS! Profile README is LIVE!`);
    console.log(`👉 View your profile: https://github.com/${username}`);
  } else {
    console.error(`❌ Failed to update README.md (${putRes.status}):`, await putRes.text());
  }

  // 5. Update user profile bio / company / blog if not set
  console.log("4. Syncing profile metadata (Bio, Socials)...");
  await fetch("https://api.github.com/user", {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({
      name: "Aditya Waghamare",
      bio: "AI & Web3 developer passionate about building scalable tech with React, Next.js, Solidity. Finalist in 8+ national hackathons and active open-source Contributor",
      blog: "https://www.adityawaghamare.in/",
      twitter_username: "",
    }),
  });
  console.log("✅ Profile bio and metadata verified!");
}

setupProfile().catch(console.error);
