import "dotenv/config";
import { Browserbase } from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import { appendFile, mkdir } from "node:fs/promises";

const contextId = process.env.X_CONTEXT_ID;
if (!contextId) throw new Error("Set your own X_CONTEXT_ID before starting a browser session.");

const apiKey = process.env.BROWSERBASE_API_KEY;
if (!apiKey) throw new Error("Set BROWSERBASE_API_KEY in .env first.");
const bb = new Browserbase({ apiKey });

// This experiment checks access only. It does not read or save posts.
const session = await bb.sessions.create({
  api_timeout: 60,
  region: "us-west-2",
  browserSettings: {
    context: { id: contextId, persist: true },
  },
});

let browser;
let outcome = "unknown";
let path = "";
let cleanup = "not_started";
try {
  browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 10000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Browser context unavailable");
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20000 });
  const authenticated = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]');
  const login = page.locator('input[autocomplete="username"], input[name="password"]');
  await Promise.race([
    authenticated.waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
    login.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
  ]);
  path = new URL(page.url()).pathname;
  if (await authenticated.isVisible()) outcome = "authenticated";
  else if (await login.first().isVisible() || /\/i\/flow\/login|\/login/.test(path)) outcome = "login_required";
  // Unknown pages remain unknown; we never dismiss challenges or attempt a login.
} catch (error) {
  outcome = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "check_error";
} finally {
  try {
    await bb.sessions.update(session.id, { status: "REQUEST_RELEASE" });
    cleanup = "release_requested";
  } catch {
    cleanup = "release_failed_session_has_60_second_limit";
  }
  await browser?.close().catch(() => {});
}

const result = { checkedAt: new Date().toISOString(), sessionId: session.id, outcome, path, cleanup };
await mkdir(".local", { recursive: true });
await appendFile(".local/login-checks.jsonl", JSON.stringify(result) + "\n");
console.log(JSON.stringify(result, null, 2));
if (outcome !== "authenticated" || cleanup !== "release_requested") process.exitCode = 1;

