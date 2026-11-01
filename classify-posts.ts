import { readFile, mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { classifyCapturedBatch, planOpportunityAssessments, preparePostRequest, HIRING_MODEL, HIRING_PIPELINE_VERSION } from './hiring-pipeline.js';
import type { HiringResult } from './hiring-pipeline.js';
import type { Post } from './x-posts.js';

const prompt = await readFile('prompts/classify-hiring-v2.txt', 'utf8');
const source = await readFile('.local/x-posts/latest.json', 'utf8');
const batch = JSON.parse(source) as { capturedAt: string; posts: Post[]; contextPosts?: Post[] };
if (!Array.isArray(batch.posts) || batch.posts.length > 120) throw new Error('This run supports at most 120 posts');
const plan = planOpportunityAssessments(batch.posts, batch.contextPosts ?? []);
const promptHash = createHash('sha256').update(prompt).digest('hex');
const runId = createHash('sha256').update(HIRING_PIPELINE_VERSION + HIRING_MODEL + prompt + source).digest('hex').slice(0, 16);
const directory = '.local/classified';
await mkdir(directory, { recursive: true, mode: 0o700 });
const filename = `${directory}/${runId}.json`;
if (process.argv.includes('--dry-run')) {
  // Preparing requests never calls the provider or overwrites classified results.
  const requests = plan.assessments.map(post => post.truncated
    ? { postId: post.id, action: 'recover_incomplete_text' }
    : { postId: post.id, request: preparePostRequest(post, plan.evidencePosts, prompt).request });
  await writeFile(`${directory}/${runId}.prepared.json`, JSON.stringify({ runId, promptHash, pipelineVersion: HIRING_PIPELINE_VERSION, addedSourceIds: plan.addedSourceIds, deferredSourceIds: plan.deferredSourceIds, requests }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Prepared ${requests.length} inputs; no model calls made.`);
} else {
  if (process.argv.includes('--resume-pending')) throw new Error('Automatic partial-run resumption is disabled. Review reserved/error results before authorizing a new run.');
  const lockPath = `${directory}/active-run.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new Error('A classifier lock exists. Check for an active/interrupted run before removing it; no calls made.');
  });
  try {
  let previous: HiringResult[] = [];
  try { previous = (JSON.parse(await readFile(filename, 'utf8')) as { results: HiringResult[] }).results; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = async (results: HiringResult[]) => {
    const summary = {
      totalPosts: plan.assessments.length, discoveryPosts: batch.posts.length, processed: results.filter(r => r.status === 'classified').length,
      keep: results.filter(r => r.decision === 'keep' && !r.duplicateOfPostId).length,
      duplicateKeeps: results.filter(r => r.decision === 'keep' && r.duplicateOfPostId).length,
      review: results.filter(r => r.decision === 'review').length,
      skip: results.filter(r => r.decision === 'skip').length,
      errors: results.filter(r => r.status === 'error').length,
    };
    const report = { model: HIRING_MODEL, pipelineVersion: HIRING_PIPELINE_VERSION, promptHash,
      addedSourceIds: plan.addedSourceIds, deferredSourceIds: plan.deferredSourceIds,
      sourceCapturedAt: batch.capturedAt, runId,
      completedAt: results.length === plan.assessments.length && results.every(r => r.status === 'classified') ? new Date().toISOString() : null,
      summary, results };
    const text = JSON.stringify(report, null, 2) + '\n';
    // Atomic replacement leaves either the prior checkpoint or the complete new one.
    for (const path of [filename, `${directory}/latest.json`]) {
      await writeFile(`${path}.tmp`, text, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    }
  };
  const { results, stopped } = await classifyCapturedBatch({ posts: batch.posts, contextPosts: batch.contextPosts ?? [], prompt, previous, fetcher: fetch, save });
  console.log(`Classified results: ${directory}/latest.json`);
  if (stopped || results.some(r => r.status !== 'classified')) process.exitCode = 1;
  } finally { await lock.close(); await unlink(lockPath); }
}
