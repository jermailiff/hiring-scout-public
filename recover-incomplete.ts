import "dotenv/config";
import { Browserbase } from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Post } from "./x-posts.js";

const batch = JSON.parse(await readFile(".local/x-posts/latest.json", "utf8")) as {
  contextId: string; posts: Post[]; stats: Record<string, unknown>; [key: string]: unknown;
};
const targets = batch.posts.filter(post => post.truncated);
if (targets.length > 24) throw new Error("This recovery is limited to the 24 selected posts");
if (!targets.length) { console.log("No incomplete posts remain."); process.exit(0); }
const contextId = process.env.X_CONTEXT_ID;
if (!contextId || contextId !== batch.contextId) throw new Error("Account profile does not match the captured batch");
const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
if ((await bb.sessions.list({ status: "RUNNING" })).some(s => s.contextId === contextId)) {
  throw new Error("The account profile is already in use");
}
const startedAt = new Date().toISOString();
const started = Date.now();
const session = await bb.sessions.create({ api_timeout: 240, region: "us-west-2",
  browserSettings: { context: { id: contextId, persist: true } } });
const results: { id: string; url: string; outcome: string; before: number; after: number; milliseconds: number; observedText?: string }[] = [];
const reportPath = `.local/recovery/${startedAt.replace(/[:.]/g, "-")}.json`;
await mkdir(".local/recovery", { recursive: true });
let next = 0;
let stopped = false;
let writes = Promise.resolve();
async function save() {
  batch.stats.stillTruncated = batch.posts.filter(post => post.truncated).length;
  batch.stats.expanded = batch.posts.filter(post => post.expansion === "expanded").length;
  batch.recoveryUpdatedAt = new Date().toISOString();
  const report = JSON.stringify({ startedAt, sessionId: session.id, selected: targets.length,
    elapsedSeconds: Math.round((Date.now() - started) / 1000), stopped, results }, null, 2) + "\n";
  const snapshot = JSON.stringify(batch, null, 2) + "\n";
  writes = writes.then(async () => {
    await writeFile(reportPath, report);
    await writeFile(".local/x-posts/latest.json", snapshot);
  });
  await writes;
}
let browser;
try {
  browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 10000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Browser context unavailable");
  async function worker() {
    const page = await context!.newPage();
    while (!stopped && next < targets.length && Date.now() - started < 210000) {
      const post = targets[next++]!;
      const start = Date.now();
      const before = post.text.length;
      let outcome = "not_expanded";
      let observedText: string | undefined;
      try {
        await page.goto(post.url, { waitUntil: "domcontentloaded", timeout: 15000 });
        if (/\/i\/flow\/login|\/login|\/account\/access|\/challenge/.test(new URL(page.url()).pathname)) {
          stopped = true; throw new Error("Login or challenge");
        }
        const card = page.locator('article[data-testid="tweet"]').filter({
          has: page.locator(`a[href$="/status/${post.id}"] time, a[href$="/status/${post.id}/history"] time`),
        }).first();
        await card.waitFor({ timeout: 20000 });
        const more = card.locator('[data-testid="tweet-text-show-more-link"]');
        if (await more.isVisible()) { await more.click({ timeout: 4000 }); await page.waitForTimeout(500); }
        const content = await card.evaluate(article => {
          const text = article.querySelector('[data-testid="tweetText"]') as HTMLElement | null;
          return { text: text?.innerText ?? "", stillShortened: !!article.querySelector('[data-testid="tweet-text-show-more-link"]') };
        });
        const normalise = (text: string) => text.replace(/https?:\/\//g, "").replace(/\s+/g, " ").trim();
        const prefixMatches = normalise(content.text).startsWith(normalise(post.text).slice(0, 80));
        if (!prefixMatches) observedText = content.text;
        // Require additional text and the original prefix before calling it recovered.
        if (!content.stillShortened && prefixMatches && content.text.length > before + 10) {
          post.text = content.text;
          post.truncated = false;
          post.expansion = "expanded";
          outcome = "recovered";
        } else outcome = content.stillShortened ? "still_shortened" : !prefixMatches ? "content_mismatch" : "no_additional_text";
      } catch { outcome = stopped ? "login_or_challenge" : "page_unavailable_or_timeout"; }
      results.push({ id: post.id, url: post.url, outcome, before, after: post.text.length, milliseconds: Date.now() - start,
        ...(observedText ? { observedText } : {}) });
      await save();
      console.log(`${results.length}/${targets.length}: ${outcome} (${post.text.length - before} extra characters)`);
    }
    await page.close();
  }
  await Promise.all([worker(), worker()]);
} finally {
  try { await bb.sessions.update(session.id, { status: "REQUEST_RELEASE" }); }
  finally { await browser?.close().catch(() => {}); }
  await save();
}
console.log(JSON.stringify({ selected: targets.length, attempted: results.length,
  recovered: results.filter(r => r.outcome === "recovered").length,
  remaining: batch.posts.filter(p => p.truncated).length,
  elapsedSeconds: Math.round((Date.now() - started) / 1000), reportPath }, null, 2));
