# Monitoring prototype

The implementation connects a bounded authenticated feed sample to hiring decisions, company/contact discovery and a private KV shortlist. The last recorded unattended attempt failed at storage access before collection or inference. Monitoring remains paused; a complete live run has not passed.

This public export contains no live collection workflow. Its only GitHub workflow runs offline checks. The example Worker configuration has no cron triggers and an expired cutoff.

## Private operational setup

Use a separate private deployment with your own `BROWSERBASE_API_KEY`, `X_CONTEXT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `SCOUT_KV_NAMESPACE_ID`. The token needs Workers AI and KV access. Credentials belong in private runtime configuration. Replace example resource placeholders before deployment.

Initialize the monitor only after checking remaining provider allowance. Set `SCOUT_ALLOWANCE_ENDS_AT` and `SCOUT_BROWSER_SECONDS_AVAILABLE`, then run `corepack pnpm monitor init`. Initialization refuses existing state. Use `corepack pnpm monitor status` to view state; investigate failures before using `resume`.

The monitor reserves 60 browser seconds and 60 model slots per run. It bounds collection to 30 posts, disables website rendering, pauses on failures, and retains supported leads when contacts are unresolved. Storage assumes one writer because KV is eventually consistent. Source-ID deduplication does not detect semantic duplicates across different IDs. A killed runner can lose partial results while reservations remain charged.

Validate one manual end-to-end run before adding a schedule. No outreach or public shortlist endpoint is included.
