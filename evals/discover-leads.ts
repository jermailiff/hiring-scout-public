import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { runLeadFlow } from '../lead-flow.js';
import { hiringDecisionJsonSchema } from '../lead-contracts.js';
import { companyIdentityJsonSchema, companyWebsiteJsonSchema, directContactJsonSchema, createCompanyDiscoverySourceLoader } from '../company-discovery.js';
import { createCloudflareCareersRenderer } from '../cloudflare-careers-renderer.js';
import { HIRING_MODEL } from '../hiring-pipeline.js';
import type { Post } from '../x-posts.js';

// Private captured posts only. This CLI does not collect X or schedule/deploy.
// No company/domain seed fields are accepted. Dry-run is the default.
const [inputPath,outputPath]=process.argv.slice(2);
if(!inputPath||!outputPath)throw Error('Usage: discover:leads PRIVATE_POSTS_JSON NEW_REPORT_JSON');
const inputSchema=z.object({posts:z.array(z.unknown()).min(1).max(12),contextPosts:z.array(z.unknown()).max(24).optional()}).strict();
const input=inputSchema.parse(JSON.parse(await readFile(inputPath,'utf8')));
const mode=process.env.DISCOVERY_MODE??'dry-run';
if(!['dry-run','live'].includes(mode))throw Error('Unknown discovery mode');
const account=process.env.CLOUDFLARE_ACCOUNT_ID??'',token=process.env.CLOUDFLARE_API_TOKEN??'';
if(mode==='live'&&(!/^[a-f0-9]{32}$/.test(account)||!token.trim()))throw Error('Missing Cloudflare runtime credentials');
const selection=await readFile(new URL('../prompts/find-hiring-opportunity.txt',import.meta.url),'utf8');
const identify=await readFile(new URL('../prompts/identify-company.txt',import.meta.url),'utf8');
const contact=await readFile(new URL('../prompts/extract-direct-contact.txt',import.meta.url),'utf8');
const verify=await readFile(new URL('../prompts/verify-company-website.txt',import.meta.url),'utf8');
const output=resolve(outputPath);
await mkdir(dirname(output),{recursive:true,mode:0o700});
const report:{mode:string;qualification:string;events:unknown[];modelRequests:unknown[];modelResponses:unknown[];result?:unknown}={mode,
  qualification:'Captured-post discovery; no supplied employer/domain answers. Search availability and model-assisted affiliation checks are fallible. Public HTML search may block automation. No semantic duplicate alias is supplied. Direct rendering has limited final redirect provenance.',events:[],modelRequests:[],modelResponses:[]};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
const save=async()=>{await writeFile(output+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(output+'.tmp',output);};
if(mode==='dry-run'){
  console.log(JSON.stringify({mode,posts:input.posts.length,newModelCalls:0,output}));
}else{
  const model=async(stage:string,prompt:string,value:unknown,schema:unknown)=>{
    if(report.modelRequests.length>=24)throw Error('Model budget exhausted');
    const request={messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(value)}],temperature:0,max_completion_tokens:800,stream:false,store:false,
      chat_template_kwargs:{enable_thinking:false},response_format:{type:'json_schema',json_schema:{name:stage,strict:true,schema}}};
    if(Buffer.byteLength(JSON.stringify(request))>50000)throw Error('Model input too large');
    report.modelRequests.push({stage,request});await save();
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${HIRING_MODEL}`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(request)});
    if(!response.ok)throw Error(`Model HTTP ${response.status}; no retry. Runtime token needs Workers AI access.`);
    const envelope=await response.json() as {success?:boolean;result?:{choices?:{message?:{content?:string}}[]}};
    report.modelResponses.push(envelope);await save();
    const raw=envelope.result?.choices?.[0]?.message?.content;
    if(!envelope.success||typeof raw!=='string')throw Error('Missing model response; no retry');return raw;
  };
  const hosts:string[]=[];
  const renderer=process.env.CAREERS_RENDERER==='cloudflare'?createCloudflareCareersRenderer({accountId:account,apiToken:token,allowedHosts:hosts,
    onDiagnostic:async diagnostic=>{report.events.push({stage:'renderer_diagnostic',...diagnostic});await save();}}):undefined;
  const loader=createCompanyDiscoverySourceLoader({
    extractContact:value=>model('direct_contact',contact,value,directContactJsonSchema),
    identifyCompany:value=>model('identify_company',identify,value,companyIdentityJsonSchema),
    verifyWebsite:value=>model('verify_website',verify,value,companyWebsiteJsonSchema),
    ...(renderer?{renderPage:async(url:string,signal:AbortSignal)=>{hosts.push(new URL(url).hostname);return renderer(url,signal);}}:{}),
    audit:async event=>{report.events.push(event);await save();},
  });
  const result=await runLeadFlow({posts:input.posts as Post[],contextPosts:(input.contextPosts??[]) as Post[],maxModelCalls:24,
    classify:(_post,context)=>model('hiring_selection',selection,context,hiringDecisionJsonSchema),loadSources:loader,
    // Discovery already attempted the employer and website. Do not re-ask a model
    // to fabricate contact metadata when evidence remains insufficient.
    enrich:async source=>JSON.stringify({source_post_id:source.id,company_name:null,company_source_ids:[],application_routes:[],needs_lookup:true,reason:'Company/official website discovery remains unresolved.'}),
    save:async checkpoint=>{report.result=checkpoint;await save();}});
  report.result=result;await save();
  console.log(JSON.stringify({mode,newModelCalls:report.modelRequests.length,opportunities:result.opportunities,stopped:result.stopped,output},null,2));
}
