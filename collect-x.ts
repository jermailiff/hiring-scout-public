import "dotenv/config";
import { Browserbase } from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { inspectLogin } from "./login-status.js";
import { hiringSignals, readPosts } from "./x-posts.js";
import type { Post } from "./x-posts.js";
import { hasHiringClue, hiringContextTarget, resolveHiringContext } from "./hiring-context.js";

const apiKey = process.env.BROWSERBASE_API_KEY;
if (!apiKey) throw new Error("Set BROWSERBASE_API_KEY in .env first.");
const bb = new Browserbase({ apiKey, maxRetries: 0 });
// Monitoring trades depth for a hard one-minute session reservation.
const bounded = process.env.SCOUT_COLLECT_BOUNDED === 'true';
const postLimit = bounded ? 30 : 120;
const contextId = process.env.X_CONTEXT_ID;
if (!contextId) throw new Error("Set X_CONTEXT_ID in .env to select the account profile.");
const running = await bb.sessions.list({ status: "RUNNING" });
if (running.some(session => session.contextId === contextId)) {
  throw new Error("The saved profile is already in use. Wait for that session to close.");
}
const session = await bb.sessions.create({
  api_timeout: bounded ? 60 : 240, region: "us-west-2",
  browserSettings: { context: { id: contextId, persist: true } },
});
let browser;
try {
  browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 10000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Browser context unavailable");
  const page = context.pages()[0] ?? await context.newPage();
  const login = await inspectLogin(page);
  if (login.outcome !== "authenticated") throw new Error(`Collection stopped: ${login.outcome}`);
  const forYou = page.getByRole("tab", { name: /^for you$/i });
  await forYou.click({ timeout: 5000 });
  if (await forYou.getAttribute("aria-selected") !== "true") throw new Error("For You tab not confirmed");
  await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: 15000 });

  const posts = new Map<string, Post>();
  let passes = 0;
  let stalls = 0;
  let feedStopReason = "pass_limit";
  const scrollProgress: { pass: number; added: number; total: number; before: number; after: number }[] = [];
  const feedDeadline = Date.now() + (bounded ? 15000 : 70000);
  while (passes < (bounded ? 8 : 40) && posts.size < postLimit && Date.now() < feedDeadline) {
    const countBefore = posts.size;
    for (const post of await readPosts(page)) {
      if (posts.size >= postLimit && !posts.has(post.id)) break;
      posts.set(post.id, post);
    }
    passes++;
    const added = posts.size - countBefore;
    stalls = added === 0 ? stalls + 1 : 0;
    if (posts.size >= postLimit) { feedStopReason = "post_limit"; break; }
    if (stalls >= 4) { feedStopReason = "no_new_posts"; break; }
    // Scroll the actual feed container, rather than sending wheel events at an
    // unspecified mouse position (which can land on the header or side panel).
    const movement = await page.locator('article[data-testid="tweet"]').last().evaluate(article => {
      let target: Element | null = article.parentElement;
      while (target && !(target.scrollHeight > target.clientHeight + 100
        && /auto|scroll/.test(getComputedStyle(target).overflowY))) target = target.parentElement;
      target ??= document.scrollingElement;
      if (!target) return { before: 0, after: 0 };
      const before = target.scrollTop;
      target.scrollBy({ top: Math.max(600, target.clientHeight * 0.85), behavior: "instant" });
      return { before, after: target.scrollTop };
    });
    scrollProgress.push({ pass: passes, added, total: posts.size, ...movement });
    await page.waitForTimeout(stalls ? 2000 : 900);
    if (passes % 5 === 0) console.log(`Feed pass ${passes}: ${posts.size} unique posts captured`);
  }
  if (Date.now() >= feedDeadline) feedStopReason = "time_budget";
  if (!posts.size) throw new Error("No posts captured; no successful batch saved");

  // Visit detail pages only for shortened posts or hiring clues, within a time/page budget.
  const roots = [...posts.values()].filter(post => post.truncated || hasHiringClue(post) || hiringContextTarget(post))
    .sort((a, b) => Number(hasHiringClue(b)) - Number(hasHiringClue(a)));
  const detail = await context.newPage();
  detail.setDefaultTimeout(4000);
  const deadline = Date.now() + (bounded ? 0 : 85000);
  let detailVisits = 0;
  let conversationsRead = 0;
  const failures: string[] = [];
  for (const root of roots) {
    if (detailVisits >= 10 || Date.now() >= deadline) { root.expansion = "budget_skipped"; continue; }
    detailVisits++;
    try {
      await detail.goto(root.url, { waitUntil: "domcontentloaded", timeout: 10000 });
      const ownCard = detail.locator('article[data-testid="tweet"]').filter({
        has: detail.locator(`a[href$="/status/${root.id}"] time, a[href$="/status/${root.id}/history"] time`),
      }).first();
      await ownCard.waitFor({ timeout: 6000 });
      // Link previews can render after the text and timestamp.
      await ownCard.locator('[data-testid="card.wrapper"]').first()
        .waitFor({ state: "visible", timeout: 1500 }).catch(() => {});
      const more = ownCard.locator('[data-testid="tweet-text-show-more-link"]');
      if (await more.isVisible()) { await more.click(); await detail.waitForTimeout(500); }
      const full = (await readPosts(detail)).find(post => post.id === root.id);
      if (full && full.text.length >= root.text.length) {
        if (root.discoveredInThread) full.discoveredInThread = root.discoveredInThread;
        full.expansion = full.truncated ? "unavailable" : root.truncated ? "expanded" : "already_full";
        // Quotes/links seen in the feed can disappear on detail pages. Preserve
        // their provenance if no replacement was observed, without merging text.
        if (!full.references && root.references) full.references = root.references;
        posts.set(root.id, full);
      } else root.expansion = "unavailable";

      const current = posts.get(root.id)!;
      if (hiringSignals(current).length && conversationsRead < 3) {
        conversationsRead++;
        const seenReplies = new Set<string>();
        let rootSeen = false;
        // Preserve context, not a guessed direct reply/parent relationship.
        for (let pass = 0; pass < 3; pass++) {
          const rootVisible = (await readPosts(detail)).some(post => post.id === root.id);
          const replies = await readPosts(detail, root.id, rootSeen);
          rootSeen ||= rootVisible;
          for (const reply of replies) {
            if (seenReplies.size >= 12) break;
            seenReplies.add(reply.id);
            if (!posts.has(reply.id)) {
              posts.set(reply.id, reply);
              if (reply.truncated) roots.push(reply);
            }
          }
          if (seenReplies.size >= 12) break;
          await detail.mouse.wheel(0, 1000); await detail.waitForTimeout(700);
        }
      }
    } catch {
      root.expansion = "unavailable";
      failures.push(root.id);
      if (/\/i\/flow\/login|\/account\/access|\/challenge/.test(new URL(detail.url()).pathname)) {
        throw new Error("Login or security challenge encountered; collection stopped");
      }
    }
  }
  // One reference per post, at most three extra navigations, sharing the existing
  // ten-page/85-second detail budget. Inline complete quotes cost no navigation.
  let referenceVisits = 0;
  const referenceCache = new Map<string, Post>();
  for (const post of posts.values()) {
    const resolved = await resolveHiringContext(post, async url => {
      const saved = posts.get(url.match(/\/status\/(\d+)$/)?.[1] ?? "") ?? referenceCache.get(url);
      if (saved && !saved.truncated && saved.url === url) return { status: "resolved", post: saved };
      if (referenceVisits >= 3 || detailVisits >= 10 || Date.now() >= deadline) return { status: "budget_skipped" };
      referenceVisits++; detailVisits++;
      try {
        await detail.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
        if (/\/i\/flow\/login|\/login|\/account\/access|\/challenge/.test(new URL(detail.url()).pathname)) {
          throw new Error("Login or security challenge encountered; collection stopped");
        }
        const id = url.match(/\/status\/(\d+)$/)![1]!;
        const card = detail.locator('article[data-testid="tweet"]').filter({
          has: detail.locator(`a[href$="/status/${id}"] time, a[href$="/status/${id}/history"] time`),
        }).first();
        await card.waitFor({ timeout: 6000 });
        const more = card.locator('[data-testid="tweet-text-show-more-link"]');
        if (await more.isVisible()) { await more.click(); await detail.waitForTimeout(500); }
        const source = (await readPosts(detail)).find(item => item.id === id && item.url === url);
        if (source && !source.truncated) {
          referenceCache.set(url, source);
          return { status: "resolved", post: source };
        }
      } catch (error) {
        if (/\/i\/flow\/login|\/login|\/account\/access|\/challenge/.test(new URL(detail.url()).pathname)) throw error;
      }
      return { status: "unavailable" };
    });
    posts.set(post.id, resolved);
  }
  const capturedAt = new Date().toISOString();
  const captured = [...posts.values()];
  const candidates = captured.flatMap(post => {
    const signals = hiringSignals(post);
    if (hiringContextTarget(post)) signals.push("hiring_reference");
    if (post.discoveredInThread && post.links.length) signals.push("link_in_hiring_conversation");
    return signals.length ? [{ postId: post.id, signals, status: "unreviewed" }] : [];
  });
  const batch = {
    capturedAt, feed: "for_you", sessionId: session.id, contextId,
    stats: { uniquePosts: posts.size, feedPosts: posts.size - captured.filter(post => post.discoveredInThread).length,
      passes, feedStopReason, scrollsWithMovement: scrollProgress.filter(step => step.after > step.before).length,
      detailVisits, referenceVisits, conversationsRead,
      expanded: captured.filter(post => post.expansion === "expanded").length,
      stillTruncated: captured.filter(post => post.truncated).length,
      threadPosts: captured.filter(post => post.discoveredInThread).length,
      candidatePosts: candidates.length },
    limitations: ["Sample, not complete feed coverage", "Keyword matches are unreviewed leads, not confirmed vacancies",
      "Only visible conversation cards are sampled; ranked replies may be missed", "Images and linked websites are not read",
      "One relevant quoted/referenced post is kept separately with its author and date; nested references are not followed",
      "Reference lookups share the detail budget and may be unavailable; current vacancy availability is not verified"],
    scrollProgress, failures, candidates, posts: captured,
  };
  await mkdir(".local/x-posts", { recursive: true, mode: 0o700 });
  const filename = `.local/x-posts/${capturedAt.replace(/[:.]/g, "-")}.json`;
  for (const file of [filename, ".local/x-posts/latest.json"]) await writeFile(file, JSON.stringify(batch, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ savedTo: filename, ...batch.stats, failedDetails: failures.length }, null, 2));
} finally {
  try { await bb.sessions.update(session.id, { status: "REQUEST_RELEASE" }); }
  finally { await browser?.close().catch(() => {}); }
}
