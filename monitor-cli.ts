import 'dotenv/config';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {runMonitor} from './monitor.js';
import type {MonitorState,MonitorStore} from './monitor.js';
import {assessFeed} from './lead-runtime.js';
import type {Post} from './x-posts.js';

const command=process.argv[2]??'status';
if(!['status','run','init','resume'].includes(command))throw Error('Use monitor status|run|init|resume');
const required=(name:string)=>{const value=process.env[name];if(!value)throw Error(`Missing ${name}`);return value;};
const account=required('CLOUDFLARE_ACCOUNT_ID'),namespace=required('SCOUT_KV_NAMESPACE_ID'),token=required('CLOUDFLARE_API_TOKEN');
if(!/^[a-f0-9]{32}$/.test(account)||!/^[a-f0-9]{32}$/.test(namespace))throw Error('Invalid account/namespace');
const url=`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/monitor-v1-state`;
const store:MonitorStore={
  get:async()=>{const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});if(r.status===404)return null;if(!r.ok)throw Error('Cannot read private monitor state');return await r.json() as MonitorState;},
  put:async state=>{const r=await fetch(url,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(state),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Cannot persist private monitor state');},
};
if(command==='init'){
  if(await store.get())throw Error('State already exists; refusing to reset usage/deduplication');
  const end=required('SCOUT_ALLOWANCE_ENDS_AT'),seconds=Number(required('SCOUT_BROWSER_SECONDS_AVAILABLE'));
  if(!Number.isFinite(Date.parse(end))||Date.parse(end)<=Date.now()||Date.parse(end)>Date.now()+31*86400000||!Number.isInteger(seconds)||seconds<60||seconds>1800)throw Error('Set verified remaining allowance (60–1800 seconds) and expiry within 31 days');
  await store.put({version:1,paused:false,reason:'Initialized; no run yet',windowEndsAt:end,browserSecondsRemaining:seconds,modelCallsRemaining:1800,lastRunId:null,lastStartedAt:null,lastCompletedAt:null,seenPostIds:[],opportunities:[]});
  console.log('Monitor initialized; schedule remains controlled separately.');
}else if(command==='resume'){
  const state=await store.get();if(!state)throw Error('Not initialized');
  state.paused=false;state.reason='Manually resumed after review; reserved usage is not reset';await store.put(state);console.log('Resumed; usage reservations preserved.');
}else if(command==='status'){
  const state=await store.get();if(!state)throw Error('Not initialized');
  await mkdir('.local/monitor',{recursive:true,mode:0o700});
  await writeFile('.local/monitor/shortlist.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({paused:state.paused,reason:state.reason,lastCompletedAt:state.lastCompletedAt,browserSecondsRemaining:state.browserSecondsRemaining,opportunities:state.opportunities},null,2));
}else{
  required('BROWSERBASE_API_KEY');required('X_CONTEXT_ID');
  if(process.env.SCOUT_MONITOR_ENABLED!=='true')throw Error('Set SCOUT_MONITOR_ENABLED=true after setup review');
  await mkdir('.local/monitor',{recursive:true,mode:0o700});
  const result=await runMonitor({runId:process.env.GITHUB_RUN_ID??new Date().toISOString(),now:new Date(),store,
    collect:async()=>{
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(process.execPath,['--import','tsx','collect-x.ts'],{stdio:'ignore',env:{...process.env,SCOUT_COLLECT_BOUNDED:'true'},timeout:80000});
        child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Collection failed; inspect login/allowance')));
      });
      const batch=JSON.parse(await readFile('.local/x-posts/latest.json','utf8')) as {posts:Post[]};return batch.posts;
    },assess:(posts,stored)=>assessFeed(posts,stored,{account,token},async checkpoint=>{
      await writeFile('.local/monitor/checkpoint.tmp',JSON.stringify(checkpoint,null,2)+'\n',{mode:0o600});await rename('.local/monitor/checkpoint.tmp','.local/monitor/checkpoint.json');
    })});
  // Logs and workflow summary contain counts only, never private feed evidence.
  console.log(JSON.stringify({status:result.status,opportunities:result.state.opportunities.length,paused:result.state.paused,reason:result.state.reason}));
  if(result.state.paused)process.exitCode=1;
}
