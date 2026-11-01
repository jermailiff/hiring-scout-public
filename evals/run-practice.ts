import { readFile, mkdir, writeFile, appendFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseClassification } from "../classification.js";
import { buildMessages, parseSuite, scoreDecisions, scoreAttributions } from "./practice-eval.js";
import type { PracticeSuite, Decision } from "./practice-eval.js";
import type { Post } from "../x-posts.js";
import { parseSourceAnswer, sourceLeadKey, sourceAnswerJsonSchema } from "./source-evidence.js";

export const MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const MAX_REQUESTS = 6;
export const EXPERIMENTS = {
  "verified-context-regression": { suite: "evals/source-evidence-cases.json", prompt: "evals/prompts/shared-opportunity-candidate.txt" },
  "verified-context-shares": { suite: "evals/attribution-boundary-cases.json", prompt: "evals/prompts/shared-opportunity-candidate.txt" },
  "verified-context-schema": { suite: "evals/attribution-boundary-cases.json", prompt: "evals/prompts/verified-context-candidate.txt" },
  "verified-context-candidate": { suite: "evals/attribution-boundary-cases.json", prompt: "evals/prompts/verified-context-candidate.txt" },
  "practice-v1": { suite: "evals/practice-cases.json", prompt: "prompts/classify-hiring.txt" },
  "boundary-baseline": { suite: "evals/boundary-cases.json", prompt: "evals/prompts/hiring-baseline.txt" },
  "boundary-candidate": { suite: "evals/boundary-cases.json", prompt: "evals/prompts/hiring-candidate.txt" },
  "policy-baseline": { suite: "evals/boundary-cases-v2.json", prompt: "evals/prompts/hiring-baseline.txt" },
  "policy-candidate": { suite: "evals/boundary-cases-v2.json", prompt: "evals/prompts/hiring-policy-v2.txt" },
  "attribution-candidate": { suite: "evals/attribution-boundary-cases.json", prompt: "evals/prompts/attribution-candidate.txt" },
  "source-evidence": { suite: "evals/source-evidence-cases.json", prompt: "evals/prompts/source-evidence.txt" },
} as const;
export function experimentFiles(name = "practice-v1") {
  if (!Object.hasOwn(EXPERIMENTS, name)) throw new Error("Unknown evaluation experiment");
  return EXPERIMENTS[name as keyof typeof EXPERIMENTS];
}
const MAX_OUTPUT_TOKENS = 1024;
type Environment = Record<string, string | undefined>;
type Prediction = { caseId: string; status: "reserved" | "valid" | "invalid_output" | "request_failed";
  attribution?: ReturnType<typeof parseSourceAnswer>; leadKey?: string | null;
  decision?: Decision; rawOutput?: string; error?: string; usage?: unknown; latencyMs?: number };
type Report = { mode: string; model: string; promptSha256: string; suiteSha256: string;
  experiment: string; suiteId: string;
  commit: string | null; runId: string | null; startedAt: string; finishedAt?: string;
  requestCap: number; temperature: number; maxCompletionTokens: number;
  status: "prepared" | "running" | "complete" | "stopped"; predictions: Prediction[];
  allowanceCheck: { method: "user_dashboard_attestation"; checkedAt: string | null };
  scores?: ReturnType<typeof scoreDecisions>; attributionScores?: ReturnType<typeof scoreAttributions>; qualification: string };

export function assertRunAllowed(env: Environment, now = Date.now()): "dry-run" | "live" {
  const mode = env.EVAL_MODE ?? "dry-run";
  if (mode !== "dry-run" && mode !== "live") throw new Error("Unknown evaluation mode");
  if (env.GITHUB_ACTIONS === "true" || mode === "live") {
    if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
      || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_RUN_ATTEMPT !== "1") {
      throw new Error("This runner requires a first-attempt manual workflow on main");
    }
    if (env.FREE_ALLOWANCES_CONFIRMED !== "true") throw new Error("Confirm free plans and remaining allowances first");
    const stamp = env.ALLOWANCE_CHECKED_AT ?? "";
    const checked = Date.parse(stamp);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(stamp)
      || !Number.isFinite(checked) || checked > now || now - checked > 15 * 60_000
      || new Date(checked).toISOString().slice(0, 10) !== new Date(now).toISOString().slice(0, 10)) {
      throw new Error("Allowance check must be within 15 minutes and the same UTC quota day");
    }
  }
  if (mode === "live") {
    if (!env.CLOUDFLARE_API_TOKEN?.trim()) throw new Error("Missing CLOUDFLARE_API_TOKEN repository secret");
    if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")) throw new Error("Missing or invalid CLOUDFLARE_ACCOUNT_ID repository secret");
  }
  return mode;
}

export function prepareRequests(prompt: string, suite: PracticeSuite, representation: 'graph' | 'verified-context' = 'graph', schemaOutput = false) {
  const size = suite.suiteId === "hiring-attribution-boundaries-v1" ? 4 : suite.suiteId === "hiring-practice-v1" ? 5 : ["hiring-boundaries-v1", "hiring-boundaries-v2", "hiring-source-evidence-v1"].includes(suite.suiteId) ? 6 : 0;
  if (!size || suite.cases.length !== size || size > MAX_REQUESTS) {
    throw new Error("This runner is restricted to the agreed four, five or six practice cases");
  }
  return suite.cases.map(example => {
    const request = { messages: buildMessages(prompt, example, representation), temperature: 0,
      max_completion_tokens: MAX_OUTPUT_TOKENS, stream: false, store: false,
      response_format: schemaOutput ? { type: 'json_schema', json_schema: {
        name: 'hiring_source_answer', strict: true, schema: sourceAnswerJsonSchema,
      } } : { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > 12_000) throw new Error("Request exceeds the fixed input budget");
    return { caseId: example.id, request };
  });
}

// Never print provider output as an Actions command or disclose environment values.
export function redact(text: string, env: Environment): string {
  for (const secret of [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID]) {
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text;
}

export async function runPractice(options: { prompt: string; suite: PracticeSuite; env: Environment;
  fetcher?: typeof fetch; save: (report: Report) => Promise<void> }) {
  const { prompt, suite, env, save } = options;
  const mode = assertRunAllowed(env);
  const requests = prepareRequests(prompt, suite, env.EVAL_EXPERIMENT?.startsWith('verified-context-') ? 'verified-context' : 'graph', ['verified-context-schema', 'verified-context-shares', 'verified-context-regression'].includes(env.EVAL_EXPERIMENT ?? ''));
  const report: Report = { mode, model: MODEL,
    experiment: env.EVAL_EXPERIMENT ?? "practice-v1", suiteId: suite.suiteId,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    suiteSha256: createHash("sha256").update(JSON.stringify(suite)).digest("hex"),
    commit: env.GITHUB_SHA ?? null, runId: env.GITHUB_RUN_ID ?? null,
    startedAt: new Date().toISOString(), requestCap: requests.length, temperature: 0,
    maxCompletionTokens: MAX_OUTPUT_TOKENS, status: mode === "live" ? "running" : "prepared",
    predictions: [], allowanceCheck: { method: "user_dashboard_attestation", checkedAt: env.ALLOWANCE_CHECKED_AT ?? null },
    qualification: suite.qualification };
  await save(report);
  if (mode === "dry-run") return report;
  const fetcher = options.fetcher ?? fetch;
  for (const [index, planned] of requests.entries()) {
    // Refuse stale checks, midnight quota rollover or changed authorization before each call.
    try { assertRunAllowed(env); } catch { report.status = "stopped"; break; }
    const row: Prediction = { caseId: planned.caseId, status: "reserved" };
    report.predictions.push(row);
    await save(report); // Reserve first; a lost connection can still consume provider usage.
    const started = Date.now();
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`, {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json" }, body: JSON.stringify(planned.request),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > 100_000) throw new Error("Oversized provider response");
      const envelope = JSON.parse(body) as any;
      if (envelope.success === false || envelope.error) throw new Error("Provider returned an unsuccessful response");
      const payload = envelope.result ?? envelope;
      row.usage = payload.usage ?? null;
      const choice = payload.choices?.[0];
      const raw = choice?.message?.content ?? payload.response;
      if (typeof raw !== "string") throw new Error("Provider returned no text");
      row.rawOutput = redact(raw, env);
      try {
        if (choice?.finish_reason === "length") throw new Error("Model output was truncated");
        // Score the raw validated model decision, without production decision overrides.
        const example = suite.cases[index]!;
        const reference = example.input.hiring_reference;
        const post: Post = { id: example.id, url: `https://example.test/synthetic/${example.id}`,
          author: "synthetic-author", authorLabel: "Synthetic author", text: example.input.text,
          postedAt: null, truncated: false, links: [],
          ...(reference?.status === "resolved" ? { hiringContext: { ...reference,
            source: { ...reference.source, links: reference.source.links.map(link => ({ ...link, expandedUrl: null })) } } } : {}) };
        if (example.input.evidence_graph) {
          row.attribution = parseSourceAnswer(raw, example.input.evidence_graph);
          row.leadKey = sourceLeadKey(row.attribution);
          row.decision = row.attribution.decision;
        } else row.decision = parseClassification(raw, example.input.text, post).decision;
        row.status = "valid";
      } catch {
        row.status = "invalid_output";
        row.error = "Output failed JSON/schema/source-quote validation or was truncated; no retry";
      }
    } catch (error) {
      row.status = "request_failed";
      // Do not persist network exception details, which may contain an authenticated URL.
      row.error = error instanceof Error && /^Cloudflare HTTP \d{3}$/.test(error.message)
        ? error.message : "Provider/authentication/network failure; no retry or fallback";
      report.status = "stopped";
    }
    row.latencyMs = Date.now() - started;
    await save(report);
    if (report.status === "stopped") break;
  }
  report.finishedAt = new Date().toISOString();
  if (report.status !== "stopped") report.status = "complete";
  report.scores = scoreDecisions(suite, report.predictions.flatMap(row => row.status === "valid" && row.decision
    ? [{ caseId: row.caseId, decision: row.decision }] : []));
  if (suite.cases.some(c => c.expected.attribution !== undefined)) {
    report.attributionScores = scoreAttributions(suite, report.predictions.filter(row => row.status === "valid"));
  }
  await save(report);
  return report;
}

async function main() {
  const env = process.env;
  const files = experimentFiles(env.EVAL_EXPERIMENT);
  const suite = parseSuite(JSON.parse(await readFile(files.suite, "utf8")));
  const prompt = await readFile(files.prompt, "utf8");
  assertRunAllowed(env); // No files or network requests if preflight fails.
  const requests = prepareRequests(prompt, suite, env.EVAL_EXPERIMENT?.startsWith('verified-context-') ? 'verified-context' : 'graph', ['verified-context-schema', 'verified-context-shares', 'verified-context-regression'].includes(env.EVAL_EXPERIMENT ?? ''));
  const directory = ".local/practice-eval";
  await mkdir(directory, { recursive: true });
  // Never reuse a partial local report; Actions uses a fresh checkout per manual run.
  try { await access(`${directory}/report.json`); throw new Error("A report already exists; preserve it before a new run"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  for (const [name, content] of [["prompt.txt", prompt], ["suite.json", JSON.stringify(suite, null, 2)],
    ["requests.json", JSON.stringify(requests, null, 2)]]) {
    await writeFile(`${directory}/${name}`, redact(content!, env), { mode: 0o600 });
  }
  const report = await runPractice({ prompt, suite, env, save: async report => {
    await writeFile(`${directory}/report.json`, redact(JSON.stringify(report, null, 2), env) + "\n", { mode: 0o600 });
  } });
  const summary = report.scores
    ? `Status: ${report.status}. Requests reserved: ${report.predictions.length}/${suite.cases.length}. Valid answers: ${report.scores.predicted}/${suite.cases.length}. Exact agreement: ${report.scores.correct}/${suite.cases.length}. Missing/invalid answers: ${report.scores.missing}.`
    : `Dry run prepared ${suite.cases.length} requests. No inference performed and no model scores produced.`;
  const attributionSummary = report.attributionScores
    ? ` Opportunity attribution: ${report.attributionScores.correct}/${report.attributionScores.total}; missing/invalid: ${report.attributionScores.missing}.` : "";
  console.log(summary + attributionSummary);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `## Hiring Scout practice evaluation\n\n${summary}${attributionSummary}\n\nSynthetic development cases; not held-out accuracy. Review raw answers in the artifact.\n`);
  if (report.status === "stopped" || report.predictions.some(row => row.status !== "valid")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Evaluation preflight or report write failed. Check secrets, allowance confirmation, mode and existing report. No retries attempted."); process.exitCode = 1; });
}
