import test from 'node:test';
import assert from 'node:assert/strict';
import {runMonitor} from './monitor.js';
import type {MonitorState,MonitorStore} from './monitor.js';
import type {Post} from './x-posts.js';
const post:Post={id:'1',url:'https://x.com/hirer/status/1',author:'hirer',authorLabel:'Hirer',text:'Hiring.',postedAt:null,truncated:false,links:[]};
const initial=():MonitorState=>({version:1,paused:false,reason:'Ready',windowEndsAt:'2026-11-01T00:00:00Z',browserSecondsRemaining:120,modelCallsRemaining:120,lastRunId:null,lastStartedAt:null,lastCompletedAt:null,seenPostIds:[],opportunities:[]});
function memory(start:MonitorState|null){let value=structuredClone(start);const writes:MonitorState[]=[];const store:MonitorStore={get:async()=>structuredClone(value),put:async next=>{value=structuredClone(next);writes.push(structuredClone(next));}};return {store,writes,read:()=>value};}
const now=new Date('2026-10-27T12:00:00Z');
test('monitor reserves usage before collection, persists shortlist and suppresses repeat posts',async()=>{
 const state=memory(initial());let classified=0;
 const options={runId:'first',now,store:state.store,collect:async()=>{assert.equal(state.read()?.paused,true);assert.equal(state.read()?.browserSecondsRemaining,60);return [post];},
 assess:async(posts:Post[])=>{classified+=posts.length;return {opportunities:[{sourceId:'1',hiringSourceUrl:post.url,companyName:null,applicationRoutes:[],needsLookup:true}],completedPostIds:['1'],stopped:false,modelCalls:2};}};
 const first=await runMonitor(options);assert.equal(first.state.opportunities.length,1);assert.equal(first.state.modelCallsRemaining,118);
 await runMonitor({...options,runId:'second',collect:async()=>[post]});assert.equal(classified,1);assert.equal(state.read()?.opportunities.length,1);
});
test('uninitialized, expired and paused monitors never open a browser',async()=>{
 for(const value of [null,{...initial(),paused:true},{...initial(),windowEndsAt:'2026-10-26T00:00:00Z'}]){
 const state=memory(value);const run=()=>runMonitor({runId:'one',now,store:state.store,collect:async()=>{assert.fail('Must not collect');},assess:async()=>{assert.fail('Must not infer');}});
 if(value===null)await assert.rejects(run,/not initialized/);else await run();
 }
});
test('collection failure stays paused with usage reserved and blocks automatic rerun',async()=>{
 const state=memory(initial());let attempts=0;
 const options={runId:'one',now,store:state.store,collect:async()=>{attempts++;throw Error('Login expired');},assess:async()=>{assert.fail('No inference');}};
 await assert.rejects(()=>runMonitor(options),/failed/);await runMonitor({...options,runId:'two'});
 assert.equal(attempts,1);assert.equal(state.read()?.browserSecondsRemaining,60);assert.equal(state.read()?.paused,true);
});
test('provider stop preserves partial leads and leaves unprocessed posts eligible',async()=>{
 const state=memory(initial());const result=await runMonitor({runId:'one',now,store:state.store,collect:async()=>[post,{...post,id:'2',url:'https://x.com/hirer/status/2'}],
 assess:async()=>({opportunities:[{sourceId:'1',hiringSourceUrl:post.url,companyName:null,applicationRoutes:[],needsLookup:true}],completedPostIds:['1'],modelCalls:2,stopped:true})});
 assert.equal(result.status,'partial');assert.equal(result.state.paused,true);assert.deepEqual(result.state.seenPostIds,['1']);assert.equal(result.state.opportunities.length,1);
});
