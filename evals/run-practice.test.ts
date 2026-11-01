import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertRunAllowed, MAX_REQUESTS, MODEL, prepareRequests, redact, runPractice, experimentFiles } from "./run-practice.js";
import { parseSuite } from "./practice-eval.js";
const suite = parseSuite(JSON.parse(await readFile(new URL("./practice-cases.json", import.meta.url), "utf8")));
function liveEnv() {
  return { EVAL_MODE: "live", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", FREE_ALLOWANCES_CONFIRMED: "true",
    ALLOWANCE_CHECKED_AT: new Date().toISOString(), CLOUDFLARE_API_TOKEN: "dummy-test-token",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) };
}
function modelAnswer(decision: string, text: string | null) {
  return Response.json({ success: true, result: { response: JSON.stringify({ decision,
    reason: "Synthetic response", evidence: text, company: null, role: null, location: null,
    author_type: "unknown", needs_context: decision === "review", evidence_source_url: null }),
    usage: { prompt_tokens: 50, completion_tokens: 25 } } });
}

test("local dry run works without credentials and never calls a provider", async () => {
  const report = await runPractice({ prompt: "Synthetic prompt", suite, env: {},
    fetcher: async () => { throw new Error("Unexpected provider call"); }, save: async () => {} });
  assert.equal(report.status, "prepared");
  assert.equal(report.predictions.length, 0);
  assert.equal(report.scores, undefined);
});

test("live preflight rejects missing secrets, non-manual events, other branches and reruns", () => {
  for (const patch of [{ CLOUDFLARE_API_TOKEN: "" }, { CLOUDFLARE_ACCOUNT_ID: "bad" },
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/unreviewed" },
    { GITHUB_RUN_ATTEMPT: "2" }, { FREE_ALLOWANCES_CONFIRMED: "false" }, { GITHUB_ACTIONS: "false" }]) {
    assert.throws(() => assertRunAllowed({ ...liveEnv(), ...patch }));
  }
});

test("allowance check must be recent, non-future and on the same UTC quota day", () => {
  const now = Date.parse("2026-10-25T00:05:00Z");
  for (const stamp of ["", "nonsense", "2026-10-24T23:59:59Z", "2026-10-25T00:05:01Z", "2026-10-25T00:04:00+00:00"]) {
    assert.throws(() => assertRunAllowed({ ...liveEnv(), ALLOWANCE_CHECKED_AT: stamp }, now));
  }
  assert.throws(() => assertRunAllowed({ ...liveEnv(), ALLOWANCE_CHECKED_AT: "2026-10-25T00:04:00Z" }, now + 20 * 60_000));
  assert.equal(assertRunAllowed({ ...liveEnv(), ALLOWANCE_CHECKED_AT: "2026-10-25T00:04:00Z" }, now), "live");
});

test("runner pins model and five-case input/output budgets without sending labels", () => {
  const requests = prepareRequests("Synthetic prompt", suite);
  assert.equal(requests.length, 5);
  assert.equal(MAX_REQUESTS, 6);
  for (const r of requests) {
    assert.equal(r.request.temperature, 0);
    assert.equal(r.request.max_completion_tokens, 1024);
    assert.equal(JSON.stringify(r.request).includes('"expected"'), false);
  }
  assert.throws(() => prepareRequests("x".repeat(12_001), suite), /input budget/);
  assert.throws(() => prepareRequests("prompt", { ...suite, cases: [...suite.cases, suite.cases[0]!] }), /agreed four, five or six/);
});

test("live runner uses five sequential mocked requests, reserving each before network access", async () => {
  let calls = 0; let reservations = 0;
  const env = liveEnv();
  const report = await runPractice({ prompt: "Synthetic prompt", suite, env,
    save: async report => { reservations = report.predictions.length; },
    fetcher: async (url, options) => {
      assert.equal(reservations, calls + 1);
      assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`);
      assert.equal(options?.redirect, "error");
      const body = JSON.parse(options?.body as string);
      assert.deepEqual(JSON.parse(body.messages[1].content), suite.cases[calls]!.input);
      const c = suite.cases[calls++]!;
      // Mock answers, not a real model evaluation.
      return modelAnswer(c.expected.decision, c.expected.decision === "keep" ? "We need someone to own onboarding." : null);
    } });
  assert.equal(calls, 5);
  assert.equal(report.status, "complete");
  assert.equal(report.scores?.correct, 5);
  assert.equal(report.predictions.every(row => row.usage !== null && row.latencyMs !== undefined), true);
});

test("provider failure or uncertain network outcome stops without a retry or fallback", async () => {
  for (const response of [() => new Response("secret error details", { status: 401 }),
    () => new Response("quota exhausted", { status: 429 }),
    () => { throw new Error("connection lost dummy-test-token"); }]) {
    let calls = 0;
    const report = await runPractice({ prompt: "prompt", suite, env: liveEnv(), save: async () => {},
      fetcher: async () => { calls++; return response(); } });
    assert.equal(calls, 1);
    assert.equal(report.status, "stopped");
    assert.equal(report.predictions[0]?.status, "request_failed");
    assert.equal(report.scores?.missing, 5);
    assert.equal(JSON.stringify(report).includes("secret error details"), false);
    assert.equal(JSON.stringify(report).includes("dummy-test-token"), false);
  }
});

test("bad evidence is recorded as invalid rather than silently repaired into a correct decision", async () => {
  let calls = 0;
  const report = await runPractice({ prompt: "prompt", suite, env: liveEnv(), save: async () => {},
    fetcher: async () => { calls++; return modelAnswer("keep", "Invented hiring evidence"); } });
  assert.equal(calls, 5); // No retries: one invalid response per case.
  assert.equal(report.predictions.every(row => row.status === "invalid_output"), true);
  assert.equal(report.scores?.correct, 0);
  assert.equal(report.scores?.missing, 5);
});

test("known secret values are removed from persisted output", () => {
  const env = liveEnv();
  const safe = redact(`Token ${env.CLOUDFLARE_API_TOKEN} account ${env.CLOUDFLARE_ACCOUNT_ID}`, env);
  assert.equal(safe, "Token [REDACTED] account [REDACTED]");
});

const boundary = parseSuite(JSON.parse(await readFile(new URL('./boundary-cases.json', import.meta.url), 'utf8')));
test('boundary comparison freezes six user labels and changes only the system prompt', async () => {
  assert.deepEqual(boundary.cases.map(c => c.expected.decision), ['skip', 'keep', 'review', 'skip', 'keep', 'review']);
  assert.throws(() => experimentFiles('../../untrusted'), /Unknown/);
  const baseline = experimentFiles('boundary-baseline');
  const candidate = experimentFiles('boundary-candidate');
  assert.equal(baseline.suite, candidate.suite);
  const oldPrompt = await readFile(baseline.prompt, 'utf8');
  const newPrompt = await readFile(candidate.prompt, 'utf8');
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(oldPrompt).digest('hex'), '88a7a31981e344fbcc1b82f190cdf1e260368b78592969be436be6567308a776');
  assert.notEqual(oldPrompt, newPrompt);
  const oldRequests = prepareRequests(oldPrompt, boundary);
  const newRequests = prepareRequests(newPrompt, boundary);
  assert.equal(oldRequests.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(oldRequests[i]!.request.messages[1], newRequests[i]!.request.messages[1]);
    assert.deepEqual({ ...oldRequests[i]!.request, messages: [] }, { ...newRequests[i]!.request, messages: [] });
    const changed = { ...boundary.cases[i]!, expected: { decision: 'keep' as const, reason: 'SECRET ANSWER KEY' } };
    const { buildMessages } = await import('./practice-eval.js');
    assert.deepEqual(buildMessages(newPrompt, changed), newRequests[i]!.request.messages);
  }
  assert.throws(() => prepareRequests(newPrompt, { ...boundary, cases: [...boundary.cases, boundary.cases[0]!] }), /agreed four, five or six/);
});

test('six-case dry run never invokes inference; live accepts only declared quote evidence', async () => {
  let calls = 0;
  const prepared = await runPractice({ prompt: 'prompt', suite: boundary, env: { EVAL_EXPERIMENT: 'boundary-baseline' },
    save: async () => {}, fetcher: async () => { throw new Error('Unexpected inference'); } });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.requestCap, 6);
  const report = await runPractice({ prompt: 'prompt', suite: boundary,
    env: { ...liveEnv(), EVAL_EXPERIMENT: 'boundary-candidate' }, save: async () => {},
    fetcher: async () => {
      const example = boundary.cases[calls++]!;
      const reference = example.input.hiring_reference;
      const fromSource = reference?.status === 'resolved';
      return Response.json({ success: true, result: { response: JSON.stringify({
        decision: example.expected.decision, reason: 'Mock response, not a model result',
        evidence: fromSource ? reference.source.text : example.input.text,
        evidence_source_url: fromSource ? reference.source.url : null,
        company: null, role: null, location: null, author_type: 'unknown', needs_context: true,
      }) } });
    } });
  assert.equal(calls, 6);
  assert.equal(report.scores?.correct, 6);
  const invalid = await runPractice({ prompt: 'prompt', suite: boundary, env: liveEnv(), save: async () => {},
    fetcher: async () => Response.json({ result: { response: JSON.stringify({ decision: 'keep', reason: 'Mock',
      evidence: 'We are too.', evidence_source_url: 'https://example.test/unrelated',
      company: null, role: null, location: null, author_type: 'unknown', needs_context: true }) } }) });
  assert.equal(invalid.predictions.every(p => p.status === 'invalid_output'), true);
});

test('policy v2 preserves prior evidence and changes only the agreed labels', async () => {
  const baseline = experimentFiles('policy-baseline');
  const candidate = experimentFiles('policy-candidate');
  assert.equal(baseline.suite, candidate.suite);
  const suiteV2 = parseSuite(JSON.parse(await readFile(baseline.suite, 'utf8')));
  assert.deepEqual(suiteV2.cases.map(c => c.expected.decision), ['skip', 'keep', 'skip', 'skip', 'keep', 'skip']);
  for (let i = 0; i < boundary.cases.length; i++) {
    assert.deepEqual(suiteV2.cases[i]!.input, boundary.cases[i]!.input);
    assert.equal(suiteV2.cases[i]!.id, boundary.cases[i]!.id);
  }
  const oldRequests = prepareRequests(await readFile(baseline.prompt, 'utf8'), suiteV2);
  const newRequests = prepareRequests(await readFile(candidate.prompt, 'utf8'), suiteV2);
  assert.equal(oldRequests.length, 6);
  for (let i = 0; i < 6; i++) assert.deepEqual(oldRequests[i]!.request.messages[1], newRequests[i]!.request.messages[1]);
  const report = await runPractice({ prompt: await readFile(candidate.prompt, 'utf8'), suite: suiteV2,
    env: { EVAL_EXPERIMENT: 'policy-candidate' }, save: async () => {},
    fetcher: async () => { throw new Error('Unexpected inference'); } });
  assert.equal(report.status, 'prepared');
  assert.equal(report.suiteId, 'hiring-boundaries-v2');
  assert.equal(report.predictions.length, 0);
});
