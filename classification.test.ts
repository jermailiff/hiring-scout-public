import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClassification } from "./classification.js";
const answer = { decision: "keep", reason: "An employer is recruiting", evidence: "We are hiring",
  company: null, role: null, location: null, author_type: "unknown", needs_context: false };

test("unknown company and role can remain null on a genuine hiring invitation", () => {
  const parsed = parseClassification(JSON.stringify(answer), "We are hiring");
  assert.equal(parsed.decision, "keep");
  assert.equal(parsed.company, null);
});
test("whitespace differences restore the exact original quote", () => {
  assert.equal(parseClassification(JSON.stringify(answer), "We are  hiring").evidence, "We are  hiring");
});
test("invented words and changed punctuation are not repaired", () => {
  for (const evidence of ["Hiring product managers in NYC", "We are hiring!"]) {
    assert.throws(() => parseClassification(JSON.stringify({ ...answer, evidence }), "We are hiring"));
  }
});
test("unsupported labels, extra fields and keep-without-evidence are rejected", () => {
  for (const patch of [{ decision: "maybe" }, { extra: "invented" }, { evidence: null }]) {
    assert.throws(() => parseClassification(JSON.stringify({ ...answer, ...patch }), "We are hiring"));
  }
});
