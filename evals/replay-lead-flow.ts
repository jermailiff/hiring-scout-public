import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runLeadFlow } from '../lead-flow.js';
import { projectLegacyHiringDecision } from './legacy-decision-adapter.js';
import type { Post } from '../x-posts.js';
import type { ContactSource } from '../lead-contracts.js';

// Read saved data only. No provider transport or web lookup is available here.
const inputPath = process.argv[2];
if (!inputPath) throw Error('Usage: pnpm replay:leads INPUT_JSON [OUTPUT_JSON]');
const outputPath = resolve(process.argv[3] ?? '.local/lead-replay/latest.json');
try { await access(outputPath); throw Error('Replay output exists; choose a new output path'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const input = JSON.parse(await readFile(inputPath, 'utf8')) as {
  posts: Post[]; contextPosts?: Post[];
  hiringResponses: Record<string, string>; enrichmentResponses: Record<string, string>;
  sources: Record<string, ContactSource[]>; storedOpportunityIds?: string[];
  legacyHiringResponses?: boolean;
};
if (!Array.isArray(input.posts) || !input.hiringResponses || !input.enrichmentResponses || !input.sources) throw Error('Incomplete saved replay input');
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
const originalOutputs: Record<string, string> = {};
const save = async (report: unknown) => {
  await writeFile(`${outputPath}.tmp`, JSON.stringify({ mode: 'offline_replay', newProviderCalls: 0,
    legacyHiringProjection: input.legacyHiringResponses === true,
    qualification: 'Recorded response replay, not a fresh model evaluation. Legacy mode projects only decision/source fields under the new product contract; it does not repair or rescore historical quote/role/source-ID failures. The code-owned ID contract is evaluated separately from the failed v1 live run; replay is not new inference.',
    originalHiringOutputs: originalOutputs, report }, null, 2) + '\n', { mode: 0o600 });
  await rename(`${outputPath}.tmp`, outputPath);
};
const result = await runLeadFlow({ posts: input.posts, contextPosts: input.contextPosts ?? [],
  storedOpportunityIds: new Set(input.storedOpportunityIds ?? []),
  classify: async post => {
    const raw = input.hiringResponses[post.id];
    if (typeof raw !== 'string') throw Error('Missing recorded hiring response');
    originalOutputs[post.id] = raw;
    if (!input.legacyHiringResponses) return raw;
    return projectLegacyHiringDecision(raw, post.id);
  },
  loadSources: async source => {
    const sources = input.sources[source.id];
    if (!sources) throw Error('Missing saved lookup evidence');
    return sources;
  },
  enrich: async source => {
    const raw = input.enrichmentResponses[source.id];
    if (typeof raw !== 'string') throw Error('Missing recorded company/contact response');
    return raw;
  }, save });
console.log(JSON.stringify({ replayedStageResponses: result.modelCalls, newProviderCalls: 0,
  opportunities: result.opportunities.length, actionableOpportunities: result.opportunities.filter(o => !o.needsLookup).length,
  kept: result.rows.filter(r => r.decision === 'keep' && !r.duplicateOfSourceId).length,
  ready: result.rows.filter(r => r.status === 'ready').length,
  skipped: result.rows.filter(r => r.decision === 'skip').length,
  lookupNeeded: result.rows.filter(r => r.status === 'lookup_needed').length, outputPath }));
