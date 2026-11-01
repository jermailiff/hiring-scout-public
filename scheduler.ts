// Cloudflare is only the timer. Browserbase runs the actual browser check.
interface Store {
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}
interface Env {
  BROWSERBASE_API_KEY: string;
  FUNCTION_ID: string;
  EXPERIMENT_ENDS_AT: string;
  SCOUT_STATE: Store;
}
interface Experiment {
  attempts: number;
  paused: boolean;
  lastSlot: number;
  reason?: string;
}

async function api(env: Env, path: string, body?: object) {
  const response = await fetch(`https://api.browserbase.com/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-bb-api-key": env.BROWSERBASE_API_KEY, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Browserbase HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

export default {
  async scheduled(event: { scheduledTime: number }, env: Env) {
    const end = Date.parse(env.EXPERIMENT_ENDS_AT);
    if (!Number.isFinite(end) || Date.now() >= end) return;
    const state = await env.SCOUT_STATE.get<Experiment>("experiment", "json")
      ?? { attempts: 0, paused: false, lastSlot: 0 };
    if (state.paused || state.attempts >= 21 || event.scheduledTime <= state.lastSlot) return;

    // Reserve the attempt before the API call. An uncertain request is never retried.
    state.attempts += 1;
    state.lastSlot = event.scheduledTime;
    state.paused = true;
    state.reason = "Check in progress or interrupted; do not retry automatically";
    await env.SCOUT_STATE.put("experiment", JSON.stringify(state));
    let outcome = "check_error";
    let invocationId: string | undefined;
    try {
      const invocation = await api(env, `/functions/${env.FUNCTION_ID}/invoke`, { params: {} });
      if (typeof invocation.id !== "string") throw new Error("Missing invocation ID");
      invocationId = invocation.id;
      for (let n = 0; n < 12; n++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const result = await api(env, `/functions/invocations/${invocationId}`);
        if (result.status === "FAILED") break;
        if (result.status === "COMPLETED") {
          const value = result.results as { outcome?: unknown } | undefined;
          if (typeof value?.outcome === "string") outcome = value.outcome;
          else outcome = "unrecognised_result";
          break;
        }
      }
      state.paused = outcome !== "authenticated";
      state.reason = state.paused ? `Stopped after ${outcome}; review before continuing` : "Last check passed";
    } catch {
      state.reason = "Request failed or completion is uncertain; review before continuing";
    }
    const record = { checkedAt: new Date().toISOString(), attempt: state.attempts, invocationId, outcome };
    await env.SCOUT_STATE.put(`check:${event.scheduledTime}`, JSON.stringify(record));
    await env.SCOUT_STATE.put("experiment", JSON.stringify(state));
    console.log(JSON.stringify(record));
  },
  // The experiment has no public endpoint that can trigger browser usage.
  fetch() { return new Response("Not found", { status: 404 }); },
};
