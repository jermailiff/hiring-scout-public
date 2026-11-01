# Evaluation evidence

Hiring Scout is evaluated as a pipeline, not a single keep/skip classifier.

## What is measured

| Stage | Checks |
|---|---|
| Hiring decision | Keep/skip/review agreement; missed leads, false positives and review rate |
| Source selection | Correct actual hiring post, reachable through verified context |
| Company identity | Evidence-backed employer name and source citation |
| Contact extraction | Explicit hiring destination; exact supporting evidence; no invented route |
| Retrieval | Official affiliation, general careers page vs individual vacancy or homepage |
| Operations | Request budgets, failure pause, persistence and repeat suppression |

Expected labels stay outside model-facing inputs. Missing/invalid responses remain failures in the relevant evaluation rather than disappearing from the denominator. Validation confirms source matching and structure; semantic correctness still needs evaluation.

## Recorded experiments

| Experiment | Observed result | Interpretation |
|---|---|---|
| Seven familiar discoveries with unseeded company search | All three expected hiring opportunities retained; two had complete company/careers results; duplicate produced four cards | Known regression test, not held-out accuracy. 18 actual model requests and one render |
| Six fresh primary posts | Human approved four skips and two keeps | Small development sample; three unresolved quote identities were excluded. Both contact stages initially failed |
| Focused contact fix on the two known failures | Company/careers/DM returned for one; DM returned with unknown client for the other | Eight fresh calls and one render. Known development regressions, not an independent test |
| Later ten primary posts | Seven model keeps and three skips; contact gaps and false route acceptance remained | Human grading pending. 32 calls and one render. One quoted opportunity had already been tested |
| First unattended monitoring attempt | Failed to read private storage before opening a browser or calling a model | Runtime integration blocker, not a classifier failure |

These are recorded observations from development. They do not establish a statistically meaningful accuracy estimate or production readiness. Earlier failures are not retroactively rescored after fixes.

## Reproducible material

- [Synthetic practice cases](evals/practice-cases.json)
- [Context/source boundary cases](evals/source-evidence-cases.json)
- [Attribution cases](evals/attribution-boundary-cases.json)
- [Contact boundary cases](evals/company-route-boundary-cases.json)
- [Practice scorer](evals/practice-eval.ts) and [runner](evals/run-practice.ts)
- Offline tests alongside implementation files

The last recorded offline suite contained 151 passing tests. These test deterministic behavior with fixtures and mocks; they are not 151 live model evaluations. Synthetic predictions used in scorer tests are not presented as measured outputs.

Raw personal-feed captures, private review notes and provider response bundles are excluded from publication. Their aggregate development observations are reported above, but those live runs cannot be fully reproduced from the public synthetic fixtures alone.

## Failure analysis

An exact quotation validator caught a model-generated website description that was absent from the retrieved page. Prompt clarification improved a focused rerun, but the same behavior recurred on a later run. The lesson is to preserve validation and measure generalization, rather than infer reliability from one successful retry.

Other observed failures include treating a homepage with a Careers navigation label as a careers page, omitting a valid careers destination, and inferring a gig's employer from the author's profile affiliation. Explicit DM contacts can still deliver value while company/website information remains unresolved.

## Next evaluation

After fixing runtime access, validate the complete unattended path. Then freeze new human labels before further prompt changes and report hiring, source attribution and contact quality separately.

