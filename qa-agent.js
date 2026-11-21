// qa-agent.js — Zero-Touch Free AI QA Agent (Gemini + Playwright + Jira)
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TICKET_KEY = process.argv[2];
const TARGET_URL = process.argv[3] || "https://www.jkctutorials.com";
const ARTIFACTS_DIR = path.resolve("./test-artifacts");
const SPEC_PATH = path.resolve("./tests/ai-generated.spec.js");

const { GEMINI_API_KEY, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
const JIRA_AUTH = "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

if (!TICKET_KEY) {
  console.error("Usage: node qa-agent.js <JIRA_TICKET_KEY> [TARGET_URL]");
  process.exit(1);
}

async function callGemini(prompt, retries = 3) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
  for (let i = 1; i <= retries; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }
    if (res.status === 503 && i < retries) {
      console.log(`Gemini 503 spike — retrying in ${i * 5}s (${i}/${retries})...`);
      await new Promise((r) => setTimeout(r, i * 5000));
      continue;
    }
    throw new Error(`Gemini API failed (${res.status}): ${await res.text()}`);
  }
}

async function getJiraTicket(key) {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${key}?fields=summary,description,project`, {
    headers: { Authorization: JIRA_AUTH, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira fetch failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function createJiraBug(projectKey, parentKey, summary, details) {
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: "Bug" },
      summary: `[AI QA] ${summary}`,
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: details }] }],
      },
    },
  };
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: "POST",
    headers: { Authorization: JIRA_AUTH, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira bug creation failed (${res.status}): ${await res.text()}`);
  const created = await res.json();

  await fetch(`${JIRA_BASE_URL}/rest/api/3/issueLink`, {
    method: "POST",
    headers: { Authorization: JIRA_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: { name: "Relates" },
      inwardIssue: { key: created.key },
      outwardIssue: { key: parentKey },
    }),
  });
  return created.key;
}

async function attachScreenshot(issueKey, filePath) {
  const form = new FormData();
  const blob = new Blob([fs.readFileSync(filePath)], { type: "image/png" });
  form.append("file", blob, path.basename(filePath));

  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`, {
    method: "POST",
    headers: { Authorization: JIRA_AUTH, "X-Atlassian-Token": "no-check" },
    body: form,
  });
  if (!res.ok) console.warn(`Screenshot upload failed (${res.status}): ${await res.text()}`);
  else console.log(`Attached screenshot ${path.basename(filePath)} -> ${issueKey}`);
}

async function commentOnJira(issueKey, text) {
  await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    headers: { Authorization: JIRA_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    }),
  });
}

(async () => {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(SPEC_PATH), { recursive: true });

  console.log(`1. Fetching Jira ticket ${TICKET_KEY}...`);
  const ticket = await getJiraTicket(TICKET_KEY);
  const projectKey = ticket.fields.project.key;
  const summary = ticket.fields.summary;
  const desc = JSON.stringify(ticket.fields.description || "");
  const rules = fs.existsSync("./e2e-test.md") ? fs.readFileSync("./e2e-test.md", "utf8") : "";

  console.log(`2. Generating Playwright tests for "${summary}"...`);
  const prompt = `You are a senior Playwright QA engineer.
Write a clean CommonJS Playwright test file (@playwright/test) for target URL: ${TARGET_URL}
Jira Ticket: ${TICKET_KEY} - ${summary}
Details: ${desc}
Extra Rules:
${rules}

Requirements:
- Write 3 concise, high-signal tests based on the ticket.
- In test.afterEach(async ({ page }, testInfo) => { ... }), if testInfo.status !== testInfo.expectedStatus, save a fullPage PNG screenshot to "${ARTIFACTS_DIR.replace(/\\/g, "/")}/" + testInfo.title.replace(/[^a-z0-9]/gi, "_") + ".png".
- Output ONLY raw JavaScript code. No markdown fences, no explanation.`;
  let validSyntax = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rawCode = await callGemini(prompt);
    const fenced = rawCode.match(/```(?:javascript|js)?\n([\s\S]*?)```/i);
    const cleanCode = (fenced ? fenced[1] : rawCode).trim();
    fs.writeFileSync(SPEC_PATH, cleanCode, "utf8");
    try {
      execSync(`node --check "${SPEC_PATH}"`, { stdio: "pipe" });
      validSyntax = true;
      console.log(`   Saved valid spec -> ${SPEC_PATH}`);
      break;
    } catch (syntaxErr) {
      console.warn(`   Attempt ${attempt} produced invalid JS syntax — retrying...`);
    }
  }

  if (!validSyntax) {
    throw new Error("AI failed to generate valid JavaScript after 2 attempts. Aborting without filing a false Jira bug.");
  }

  console.log("3. Running Playwright headlessly...");
  let output = "";
  let failed = false;
  try {
    output = execSync(`npx playwright test "${SPEC_PATH}" --reporter=list`, { encoding: "utf8" });
  } catch (err) {
    failed = true;
    output = (err.stdout || "") + "\n" + (err.stderr || "");
  }
  console.log(output);

  if (!failed) {
    await commentOnJira(TICKET_KEY, `AI QA Agent passed all automated Playwright checks on ${TARGET_URL}.`);
    console.log("All tests passed! Posted green summary to Jira.");
    return;
  }

  console.log("4. Failures detected — filing Jira bug and attaching screenshots...");
  const bugKey = await createJiraBug(
    projectKey,
    TICKET_KEY,
    `Test failures on ${TICKET_KEY}`,
    `Target: ${TARGET_URL}\n\nPlaywright Output:\n${output.slice(0, 3000)}`
  );
  console.log(`   Created Jira Bug: ${bugKey}`);

  const pngs = fs.readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith(".png"));
  for (const png of pngs) {
    await attachScreenshot(bugKey, path.join(ARTIFACTS_DIR, png));
  }

  await commentOnJira(
    TICKET_KEY,
    `AI QA Agent detected failures on ${TARGET_URL}. Filed bug ${bugKey} with ${pngs.length} screenshot(s) attached.`
  );
  console.log(`Done! Check ${bugKey} and ${TICKET_KEY} in Jira.`);
})();
