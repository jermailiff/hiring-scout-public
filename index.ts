import "dotenv/config";
import { Browserbase } from "@browserbasehq/sdk";

const contextId = process.env.X_CONTEXT_ID;
if (!contextId) throw new Error("Set your own X_CONTEXT_ID before starting a browser session.");

const apiKey = process.env.BROWSERBASE_API_KEY;
if (!apiKey) {
  throw new Error("Add BROWSERBASE_API_KEY to your .env file before running this script.");
}

const browserbase = new Browserbase({ apiKey });

const session = await browserbase.sessions.create({
  api_timeout: 300,
  browserSettings: {
    context: {
      id: contextId,
      persist: true,
    },
  },
});

console.log(`Open your browser: https://browserbase.com/sessions/${session.id}`);
console.log("This session will end automatically after five minutes.");

