import "dotenv/config";
import { defineFn } from "@browserbasehq/sdk-functions";
import { chromium } from "playwright-core";
import { z } from "zod";
import { inspectLogin } from "./login-status.js";

const contextId = process.env.X_CONTEXT_ID;
if (!contextId) throw new Error("Set your own X_CONTEXT_ID before starting a browser session.");

defineFn("hiring-scout-login-check", async ({ session }) => {
  // Browserbase supplies this session and closes it when the handler returns.
  const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 10000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Browser context unavailable");
  const page = context.pages()[0] ?? await context.newPage();
  const status = await inspectLogin(page);
  return { checkedAt: new Date().toISOString(), sessionId: session.id, ...status };
}, {
  parametersSchema: z.object({}).strict(),
  sessionConfig: {
    api_timeout: 60,
    browserSettings: {
      context: { id: contextId, persist: true },
    },
  },
});

