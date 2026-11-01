import { test } from "node:test";
import assert from "node:assert/strict";
import scheduler from "./scheduler.js";

function fixture(initial?: object) {
  const data = new Map<string, string>();
  if (initial) data.set("experiment", JSON.stringify(initial));
  return {
    data,
    env: {
      BROWSERBASE_API_KEY: "dummy-test-key",
      FUNCTION_ID: "dummy-function",
      EXPERIMENT_ENDS_AT: new Date(Date.now() + 86400000).toISOString(),
      SCOUT_STATE: {
        async get<T>(key: string) { return data.has(key) ? JSON.parse(data.get(key)!) as T : null; },
        async put(key: string, value: string) { data.set(key, value); },
      },
    },
  };
}

test("expired, paused, exhausted and repeated slots never invoke a browser", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected API call"); });
  for (const state of [
    { attempts: 21, paused: false, lastSlot: 0 },
    { attempts: 1, paused: true, lastSlot: 0 },
    { attempts: 1, paused: false, lastSlot: 100 },
  ]) {
    const f = fixture(state);
    await scheduler.scheduled({ scheduledTime: 100 }, f.env);
  }
  const f = fixture();
  f.env.EXPERIMENT_ENDS_AT = "2020-01-01T00:00:00Z";
  await scheduler.scheduled({ scheduledTime: 100 }, f.env);
  assert.equal(calls, 0);
});

test("uncertain invocation consumes an attempt and pauses instead of retrying", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Connection lost"); });
  const f = fixture();
  await scheduler.scheduled({ scheduledTime: 100 }, f.env);
  await scheduler.scheduled({ scheduledTime: 200 }, f.env);
  const state = JSON.parse(f.data.get("experiment")!);
  assert.equal(calls, 1);
  assert.equal(state.attempts, 1);
  assert.equal(state.paused, true);
});

test("only a confirmed authenticated result allows the experiment to continue", async t => {
  for (const outcome of ["authenticated", "login_required", "challenge", "unknown"]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json(calls === 1 ? { id: "dummy-invocation" }
        : { status: "COMPLETED", results: { outcome } });
    });
    const f = fixture();
    await scheduler.scheduled({ scheduledTime: 100 }, f.env);
    const state = JSON.parse(f.data.get("experiment")!);
    assert.equal(state.paused, outcome !== "authenticated");
    assert.equal(state.attempts, 1);
    t.mock.restoreAll();
  }
});
