# Hiring Scout

An LLM-powered hiring scout that turns social-feed posts into a shortlist of companies hiring, with the original hiring source and a careers page or explicit DM/email contact when supported.

Built by Jermaine Ijieh as a practical AI product project: defining a decision rubric, building evaluation datasets, tracing failures, and integrating model decisions with browser collection and persistent storage.

**Status: working components and an integrated monitoring prototype. Unattended operation has not yet passed its first end-to-end run.** The last live monitoring attempt stopped at Cloudflare storage access, before collection or inference.

## Product flow

1. Sample an authenticated X feed using a saved browser profile.
2. Recover available post/context evidence within bounded navigation limits.
3. Classify current recruitment as keep, skip or review and select the actual hiring source.
4. Extract company identity and explicit hiring contacts, or search for an official careers page.
5. Validate model outputs and save a shortlist with source-ID deduplication.

Unknown contacts remain unresolved rather than discarding the hiring opportunity. Feed sampling is bounded and does not guarantee full coverage.

## AI engineering decisions

- **Separate decisions:** hiring detection, source attribution, employer identity and contact retrieval are evaluated independently.
- **Structured outputs:** Zod/JSON schemas enforce response shape; source IDs and quotations must match supplied evidence.
- **Context boundaries:** only verified reply/quote relationships within two connections can support attribution. Thread proximity is insufficient.
- **Code owns provenance:** selected source identities and self-DM destinations are mapped from captured evidence.
- **Failure containment:** request reservations, caps, checkpoints and pause-on-failure behavior bound unattended work.
- **Honest evaluation:** synthetic cases, known regressions and fresh human-reviewed examples are reported separately. Offline test counts are not model accuracy.

See [evaluation evidence](EVALUATION.md), [eval code and datasets](evals/), and [monitor setup](MONITORING.md).

## Architecture

| Layer | Main files |
|---|---|
| Browser collection and evidence | `collect-x.ts`, `x-posts.ts`, `hiring-context.ts` |
| Context graph and source validation | `hiring-evidence.ts`, `hiring-pipeline.ts`, `lead-contracts.ts` |
| Hiring/contact orchestration | `lead-flow.ts`, `company-discovery.ts`, `careers-lookup.ts` |
| Model prompts | `prompts/` |
| Evaluation runner and datasets | `evals/` |
| Scheduled monitoring and private persistence | `monitor.ts`, `monitor-cli.ts`, `lead-runtime.ts` |

Stack: TypeScript, Node 22, pnpm, Playwright/Browserbase, Cloudflare Workers AI (Gemma), Workers KV, GitHub Actions.

## Run offline

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm eval:practice
```

The practice eval defaults to dry-run. Browser collection and live inference require separately configured credentials and consume provider allowance. Secrets and personal feed evidence are excluded from source control.

**Public export validation (November 1, 2026):** typecheck and all 151 offline tests passed; the five-case practice dry-run completed with zero inference calls. Local checks reused installed dependencies; the included CI performs a frozen-lockfile installation.

## Limits and next milestone

The immediate milestone is a successful scheduled collection → classification → saved shortlist run. Remaining gaps include runtime storage authorization, browser/login reliability, incomplete reply capture, careers-page detection, employer attribution from profiles, and semantic deduplication across different post IDs.

A later fresh-post evaluation repeated an invented website-verification quotation. Strict validation rejected it while preserving the supported company and DM contact. This illustrates why a passing focused regression is not enough to establish general reliability.

No outreach, exhaustive feed coverage, production reliability or held-out accuracy claim is made.

This public showcase has clean history, synthetic fixtures and placeholder configuration. Personal feed captures, internal notes, account identifiers and live workflows are excluded.
