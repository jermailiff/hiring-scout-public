import type { Post } from './x-posts.js';
import type { HiringOpportunity } from './opportunities.js';
export interface MonitorState {
  version:1; paused:boolean; reason:string; windowEndsAt:string;
  browserSecondsRemaining:number; modelCallsRemaining:number;
  lastRunId:string|null; lastStartedAt:string|null; lastCompletedAt:string|null;
  seenPostIds:string[]; opportunities:HiringOpportunity[];
}
export interface MonitorStore {get():Promise<MonitorState|null>;put(state:MonitorState):Promise<void>}
export async function runMonitor(options:{
  runId:string;now:Date;store:MonitorStore;
  collect:()=>Promise<Post[]>;
  assess:(posts:Post[],storedIds:ReadonlySet<string>)=>Promise<{opportunities:HiringOpportunity[];completedPostIds:string[];stopped:boolean;modelCalls:number}>;
}) {
  const state=await options.store.get();
  if(!state)throw Error('Monitor not initialized; no collection started');
  if(state.version!==1||!Number.isFinite(Date.parse(state.windowEndsAt))
    ||!Number.isInteger(state.browserSecondsRemaining)||state.browserSecondsRemaining<0
    ||!Number.isInteger(state.modelCallsRemaining)||state.modelCallsRemaining<0)throw Error('Invalid monitor state');
  if(state.paused||state.lastRunId===options.runId)return {status:'paused_or_duplicate',state};
  if(options.now.getTime()>=Date.parse(state.windowEndsAt)||state.browserSecondsRemaining<60||state.modelCallsRemaining<60){
    state.paused=true;state.reason='Usage window expired or reserved allowance exhausted';await options.store.put(state);return {status:'budget_exhausted',state};
  }
  // Single serialized scheduler only. KV is not a distributed locking service.
  // Reserve worst-case usage and pause BEFORE any provider call. Interrupted runs
  // remain paused; no automatic retry or speculative refund of reserved usage.
  state.browserSecondsRemaining-=60;state.modelCallsRemaining-=60;
  state.lastRunId=options.runId;state.lastStartedAt=options.now.toISOString();
  state.paused=true;state.reason='Run in progress or interrupted; review before resuming';
  await options.store.put(state);
  try{
    const posts=await options.collect();
    if(!posts.length)throw Error('Collection returned no posts');
    const unique=[...new Map(posts.map(p=>[p.id,p])).values()];
    const seen=new Set(state.seenPostIds);
    const unseen=unique.filter(p=>!seen.has(p.id));
    const result=unseen.length?await options.assess(unseen,new Set(state.opportunities.map(o=>o.sourceId))):
      {opportunities:[],completedPostIds:[],stopped:false,modelCalls:0};
    if(!Number.isInteger(result.modelCalls)||result.modelCalls<0||result.modelCalls>60)throw Error('Invalid model usage');
    const shortlist=new Map(state.opportunities.map(o=>[o.sourceId,o]));
    for(const opportunity of result.opportunities)shortlist.set(opportunity.sourceId,opportunity);
    state.opportunities=[...shortlist.values()].slice(-500);
    state.seenPostIds=[...new Set([...state.seenPostIds,...result.completedPostIds])].slice(-10000);
    state.lastCompletedAt=new Date().toISOString();
    state.paused=result.stopped;
    state.reason=result.stopped?'Inference stopped; partial shortlist saved; review before resuming':'Last run completed';
    // Unused model slots are safe to refund only after a known completion.
    state.modelCallsRemaining+=60-result.modelCalls;
    await options.store.put(state);
    return {status:result.stopped?'partial':'completed',captured:unique.length,unseen:unseen.length,state};
  }catch{
    state.paused=true;
    state.reason='Collection, inference or persistence failed; review before resuming';
    await options.store.put(state);
    throw Error(state.reason);
  }
}
