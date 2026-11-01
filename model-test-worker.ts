// Local development bridge only. No production URL or schedule is deployed.
interface ModelEnv { AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> }; MAX_MODEL_CALLS?: string }
const allowed = new Set(["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it"]);
let calls = 0;
export default {
  async fetch(request: Request, env: ModelEnv) {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const input = await request.json() as Record<string, unknown>;
    if (typeof input.model !== "string" || !allowed.has(input.model)) return new Response("Model not allowed", { status: 400 });
    const limit = Math.min(120, Math.max(1, Number(env.MAX_MODEL_CALLS ?? 22) || 22));
    if (calls >= limit) return new Response("Model call limit reached", { status: 429 });
    if (JSON.stringify(input).length > 30000) return new Response("Input too large", { status: 413 });
    calls++;
    try { return Response.json(await env.AI.run(input.model, input)); }
    catch { return Response.json({ error: "Cloudflare AI request failed; no fallback attempted" }, { status: 502 }); }
  },
};
