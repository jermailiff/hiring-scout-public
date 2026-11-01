import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseClassification } from "./classification.js";

const models = ["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it"];
const prompt = await readFile("prompts/classify-hiring.txt", "utf8");
const examples = JSON.parse(await readFile("prompts/classification-examples.json", "utf8")) as {
  cases: { id: string; input: { text: string; [key: string]: unknown }; expected: { decision: string } }[];
};
if (examples.cases.length > 11) throw new Error("This comparison is capped at 11 examples per model");

// Wrangler supplies account authorization through its remote AI binding.
// This process sends only test inputs to a loopback-only development bridge.
const rows: Record<string, unknown>[] = [];
let stop = false;
const startedAt = new Date().toISOString();
await mkdir(".local/model-comparisons", { recursive: true });
const path = `.local/model-comparisons/${startedAt.replace(/[:.]/g, "-")}.json`;
async function save() {
  await writeFile(path, JSON.stringify({ startedAt, promptHash: createHash("sha256").update(prompt).digest("hex"),
    qualification: "Initial rubric-example comparison, not an independent held-out evaluation. No paid fallback or automatic retries.", rows }, null, 2) + "\n");
}
for (const model of models) {
  for (const example of examples.cases) {
    const start = Date.now();
    const row: Record<string, unknown> = { model, caseId: example.id, expected: example.expected.decision };
    try {
      const response = await fetch("http://127.0.0.1:8791", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model, messages: [{ role: "system", content: prompt },
            // Only input goes to the model; expected answers stay in this evaluator.
            { role: "user", content: JSON.stringify(example.input) }],
          temperature: 0, max_completion_tokens: 1024, stream: false, store: false,
          response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) {
        row.error = `HTTP ${response.status}`;
        // Stop on permission, payment, quota or incompatible-request errors. Never upgrade or retry.
        stop = true;
      } else {
        const envelope = await response.json() as any;
        if (envelope.success === false) throw new Error("Provider returned an unsuccessful response");
        const result = envelope.result ?? envelope;
        row.usage = result.usage ?? envelope.usage ?? null;
        const choice = result.choices?.[0];
        row.finishReason = choice?.finish_reason ?? null;
        const content = choice?.message?.content ?? result.response;
        if (typeof content !== "string") throw new Error("Missing text response");
        row.rawOutput = content;
        if (choice?.finish_reason === "length") throw new Error("Output truncated by token limit");
        const parsed = parseClassification(content, example.input.text);
        row.output = parsed;
        row.correct = parsed.decision === example.expected.decision;
        // Extraction warnings prompt human review; they do not silently alter decisions.
        const source = JSON.stringify(example.input).toLowerCase().replace(/[^a-z0-9]+/g, " ");
        row.extractionWarnings = ["company", "role", "location"].filter(key => {
          const value = parsed[key as "company" | "role" | "location"];
          return value !== null && !source.includes(value.toLowerCase().replace(/[^a-z0-9]+/g, " "));
        });
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : "Evaluation error";
    }
    row.latencyMs = Date.now() - start;
    rows.push(row);
    console.log(`${model.split("/").at(-1)} / ${example.id}: ${row.error ?? (row.correct ? "agrees" : "disagrees")}`);
    await save();
    if (stop) break;
  }
  if (stop) break;
}
for (const model of models) {
  const results = rows.filter(row => row.model === model);
  console.log(JSON.stringify({ model, attempted: results.length, totalExamples: examples.cases.length,
    agreements: results.filter(row => row.correct === true).length,
    errors: results.filter(row => row.error).length,
    extractionWarnings: results.filter(row => Array.isArray(row.extractionWarnings) && row.extractionWarnings.length).length }));
}
console.log(`Report: ${path}`);
if (stop) process.exitCode = 1;
