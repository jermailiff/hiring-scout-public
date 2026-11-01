import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Page } from "playwright-core";
import { readPosts } from "./x-posts.js";
import type { Post } from "./x-posts.js";
import { contextNeedsReview, hiringContextTarget, markDuplicateLeads, resolveHiringContext } from "./hiring-context.js";
import type { LeadRow } from "./hiring-context.js";
import { applyClassification, parseClassification } from "./classification.js";

// Synthetic examples only. Private feed evidence and screenshots stay outside Git.
function post(id: string, text: string, rest: Partial<Post> = {}): Post {
  return { id, text, url: `https://x.com/person/status/${id}`, author: "person", authorLabel: "Person",
    postedAt: "2026-10-20T00:00:00.000Z", truncated: false, links: [], ...rest };
}
const invitation = post("100", "I'm assembling a team", { postedAt: "2026-09-02T00:00:00.000Z" });
const historical = post("200", "Since this tweet, we've hired from several companies", {
  references: [{ url: invitation.url, relationship: "quoted_post", post: invitation }],
});
function output(decision: "keep" | "skip" | "review", evidence: string | null, url: string | null = null) {
  return JSON.stringify({ decision, evidence, evidence_source_url: url, reason: "Test assessment",
    company: null, role: null, location: null, author_type: "unknown", needs_context: false });
}

test("hiring update resolves an inline invitation with its own date and identity, without navigation", async () => {
  const resolved = await resolveHiringContext(historical, async () => { throw new Error("No lookup expected"); });
  assert.equal(resolved.text, historical.text);
  assert.equal(resolved.hiringContext?.status, "resolved");
  const result = applyClassification(resolved, parseClassification(output("keep", "I'm assembling a team", invitation.url), resolved.text, resolved));
  assert.equal(result.decision, "keep");
  assert.equal(result.evidenceSource?.url, invitation.url);
  assert.equal(result.evidenceSource?.postedAt, invitation.postedAt);
  assert.equal(result.evidenceSource?.currentAvailabilityVerified, false);
});

test("linked reference resolves once and strips second-level references", async () => {
  const p = post("201", "We have hired since this post", { references: [{ url: invitation.url, relationship: "linked_post" }] });
  const calls: string[] = [];
  const resolved = await resolveHiringContext(p, async url => {
    calls.push(url);
    return { status: "resolved", post: { ...invitation, references: [{ url: "https://x.com/person/status/999", relationship: "linked_post" }] } as Post };
  });
  assert.deepEqual(calls, [invitation.url]);
  assert.equal(resolved.hiringContext?.status, "resolved");
  if (resolved.hiringContext?.status === "resolved") assert.equal("references" in resolved.hiringContext.source, false);
});

test("missing, unavailable and budget-skipped references prevent silent discard", async () => {
  for (const status of ["unavailable", "budget_skipped"] as const) {
    const p = post("202", "Since this tweet, we've hired a team", { references: [{ url: invitation.url, relationship: "linked_post" }] });
    const resolved = await resolveHiringContext(p, async () => ({ status }));
    assert.equal(contextNeedsReview(resolved), true);
    const result = applyClassification(resolved, parseClassification(output("skip", null), p.text, resolved));
    assert.equal(result.decision, "review");
    assert.match(result.reason, /Missing hiring context/);
  }
  const noUrl = post("203", "Since this tweet, we've hired a team");
  const resolved = await resolveHiringContext(noUrl, async () => { throw new Error("No known URL"); });
  assert.equal(resolved.hiringContext?.status, "unavailable");
  assert.equal(contextNeedsReview(noUrl), true); // Older saved batches lack the new context field.
});

test("standalone invitation stays keep; missing details do not require a lookup", async () => {
  const p = post("204", "Come work with us");
  assert.equal(hiringContextTarget(p), null);
  const result = applyClassification(p, parseClassification(output("keep", p.text, p.url), p.text, p));
  assert.equal(result.decision, "keep");
});

test("networking and product news without hiring references do not trigger lookups", async () => {
  for (const text of ["I'm starting a company, let's chat", "My new product launched", "Open to cold DMs"]) {
    const p = post("205", text, { references: [{ url: invitation.url, relationship: "linked_post" }] });
    const resolved = await resolveHiringContext(p, async () => { throw new Error("No lookup expected"); });
    assert.equal(resolved.hiringContext, undefined);
    assert.equal(hiringContextTarget(p), null);
  }
});

test("short quote reactions surface source evidence, but applicant decisions remain skip", async () => {
  const reaction = post("206", "THIS", { references: historical.references! });
  const resolved = await resolveHiringContext(reaction, async () => { throw new Error("No lookup expected"); });
  assert.equal(resolved.hiringContext?.status, "resolved");
  const applicant = post("207", "I'd love to join your team; here's my portfolio", {
    discoveredInThread: invitation.id, references: historical.references!,
  });
  const withContext = await resolveHiringContext(applicant, async () => { throw new Error("No lookup expected"); });
  assert.equal(applyClassification(withContext, parseClassification(output("skip", null), applicant.text, withContext)).decision, "skip");
});

test("evidence must be an exact quote from the declared, resolved source", async () => {
  const resolved = await resolveHiringContext(historical, async () => { throw new Error("No lookup expected"); });
  assert.throws(() => parseClassification(output("keep", "I'm assembling a team", historical.url), historical.text, resolved));
  assert.throws(() => parseClassification(output("keep", "We're hiring everyone", invitation.url), historical.text, resolved));
  assert.throws(() => parseClassification(output("keep", invitation.text, "https://x.com/person/status/999"), historical.text, resolved));
  assert.throws(() => parseClassification(output("keep", invitation.text, invitation.url), historical.text, historical));
  assert.throws(() => parseClassification(output("keep", invitation.text, invitation.url), historical.text));
});

test("truncated, mismatched and unsafe references are not treated as resolved evidence", async () => {
  for (const bad of [{ ...invitation, truncated: true }, post("999", "We are hiring")]) {
    const p = post("208", "Since this post, we've hired", { references: [{ url: invitation.url, relationship: "linked_post" }] });
    const result = await resolveHiringContext(p, async () => ({ status: "resolved", post: bad }));
    assert.equal(result.hiringContext?.status, "unavailable");
  }
  for (const url of ["https://example.com/private", "http://127.0.0.1/status/100", "https://x.com@evil.test/person/status/100"]) {
    const p = post("209", "Since this post, we've hired", { references: [{ url, relationship: "linked_post" }] });
    const result = await resolveHiringContext(p, async () => { throw new Error("Unsafe navigation"); });
    assert.equal(result.hiringContext?.status, "unavailable");
  }
});

test("same source opportunity is counted once, preferring its original post regardless of order", () => {
  const rows: LeadRow[] = [
    { postId: "200", decision: "keep", evidenceSource: { id: "100" } },
    { postId: "206", decision: "keep", evidenceSource: { id: "100" } },
    { postId: "100", decision: "keep", evidenceSource: { id: "100" } },
    { postId: "207", decision: "skip" },
  ];
  markDuplicateLeads(rows);
  assert.deepEqual(rows.map(r => r.duplicateOfPostId), ["100", "100", undefined, undefined]);
});

async function readFixture(html: string): Promise<Post[]> {
  const { document, Node } = parseHTML(html);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousNode = Object.getOwnPropertyDescriptor(globalThis, "Node");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: Node });
  try {
    const page = { locator: () => ({ evaluateAll: (fn: (elements: Element[]) => unknown) =>
      fn([...document.querySelectorAll('article[data-testid="tweet"]')] as unknown as Element[]) }) } as unknown as Page;
    return await readPosts(page);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
    if (previousNode) Object.defineProperty(globalThis, "Node", previousNode); else Reflect.deleteProperty(globalThis, "Node");
  }
}

test("DOM fixture keeps edited main and quoted identities, links, dates and truncation separate", async () => {
  const rows = await readFixture(`<article data-testid="tweet">
    <span data-testid="User-Name">Discoverer</span>
    <a href="/discoverer/status/200/history"><time datetime="2026-10-20T00:00:00Z"></time></a>
    <div data-testid="tweetText">Since this tweet, we've hired</div>
    <div role="link"><span data-testid="User-Name">Employer</span>
      <a href="/employer/status/100"><time datetime="2026-09-02T00:00:00Z"></time></a>
      <div data-testid="tweetText">I'm assembling a team <a href="https://example.com/jobs">Apply</a></div>
      <span data-testid="tweet-text-show-more-link">Show more</span>
    </div></article>`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "200");
  assert.equal(rows[0]?.author, "discoverer");
  assert.equal(rows[0]?.truncated, false);
  assert.deepEqual(rows[0]?.links, []);
  const quote = rows[0]?.references?.[0]?.post;
  assert.equal(quote?.id, "100");
  assert.equal(quote?.author, "employer");
  assert.equal(quote?.authorLabel, "Employer");
  assert.equal(quote?.postedAt, "2026-09-02T00:00:00Z");
  assert.equal(quote?.truncated, true);
  assert.equal(quote?.links[0]?.url, "https://example.com/jobs");
  assert.equal(rows[0]?.text.includes("assembling"), false);
});

test("DOM fixture preserves direct X links but not unrelated websites as references", async () => {
  const rows = await readFixture(`<article data-testid="tweet">
    <a href="/person/status/300"><time datetime="2026-10-20"></time></a>
    <div data-testid="tweetText">We've hired since <a href="https://twitter.com/employer/status/100?x=1">this post</a>
    <a href="https://example.com">our site</a></div></article>`);
  assert.deepEqual(rows[0]?.references, [{ url: "https://x.com/employer/status/100", relationship: "linked_post" }]);
});

test("quote without a timestamp can retain its explicit permalink; unidentified hiring quote requires review", async () => {
  for (const withLink of [true, false]) {
    const rows = await readFixture(`<article data-testid="tweet">
      <a href="/person/status/400"><time datetime="2026-10-20"></time></a>
      <div data-testid="tweetText">THIS</div>
      <div role="link">${withLink ? '<a href="/employer/status/100">Employer</a>' : ''}
        <div data-testid="tweetText">We're hiring designers</div>
      </div></article>`);
    const p = rows[0]!;
    assert.equal(p.references?.[0]?.url, withLink ? "https://x.com/employer/status/100" : null);
    const resolved = await resolveHiringContext(p, async () => { throw new Error("No lookup expected"); });
    assert.equal(resolved.hiringContext?.status, withLink ? "resolved" : "unavailable");
  }
});
