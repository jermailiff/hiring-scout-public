import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMessages, parseSuite, scoreDecisions } from "./practice-eval.js";
const suite = parseSuite(JSON.parse(await readFile(new URL("./practice-cases.json", import.meta.url), "utf8")));

test("practice suite preserves the five agreed labels", () => {
  assert.deepEqual(suite.cases.map(c => c.expected.decision), ["keep", "skip", "review", "skip", "review"]);
});

test("outgoing model inputs do not include expected labels or their reasons", () => {
  for (const example of suite.cases) {
    const messages = buildMessages("Synthetic system prompt", example);
    assert.equal(messages.length, 2);
    assert.deepEqual(JSON.parse(messages[1]!.content), example.input);
    const changedKey = { ...example, expected: { decision: "review" as const, reason: "SECRET ANSWER KEY" } };
    assert.deepEqual(buildMessages("Synthetic system prompt", changedKey), messages);
    assert.equal(JSON.stringify(messages).includes("SECRET ANSWER KEY"), false);
  }
});

test("all-review predictions do not masquerade as a perfect score", () => {
  const score = scoreDecisions(suite, suite.cases.map(c => ({ caseId: c.id, decision: "review" })));
  assert.equal(score.correct, 2);
  assert.equal(score.exactAgreement, 2 / 5);
  assert.equal(score.missedLeads, 0);
  assert.equal(score.leadsDeferredToReview, 1);
  assert.equal(score.reviewRate, 1);
  assert.equal(score.unnecessaryReviews, 3);
});

test("missing predictions remain in the denominator; duplicate and unknown IDs are rejected", () => {
  const first = { caseId: suite.cases[0]!.id, decision: "keep" as const };
  const score = scoreDecisions(suite, [first]);
  assert.equal(score.missing, 4);
  assert.equal(score.exactAgreement, 1 / 5);
  assert.throws(() => scoreDecisions(suite, [first, first]), /Duplicate/);
  assert.throws(() => scoreDecisions(suite, [{ caseId: "invented", decision: "skip" }]), /Unknown/);
});

test("clear misses, false alarms and unsafe decisions on ambiguous cases are counted separately", () => {
  const score = scoreDecisions(suite, suite.cases.map((c, index) => ({ caseId: c.id,
    decision: index === 0 || index === 4 ? "skip" : "keep" })));
  assert.equal(score.missedLeads, 1);
  assert.equal(score.falseAlarms, 2);
  assert.equal(score.uncertainCasesAutoKept, 1);
  assert.equal(score.uncertainCasesAutoSkipped, 1);
});
