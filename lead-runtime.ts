import {readFile} from 'node:fs/promises';
import {runLeadFlow} from './lead-flow.js';
import {hiringDecisionJsonSchema} from './lead-contracts.js';
import {createCompanyDiscoverySourceLoader,companyIdentityJsonSchema,companyWebsiteJsonSchema,directContactJsonSchema} from './company-discovery.js';
import {HIRING_MODEL} from './hiring-pipeline.js';
import type {Post} from './x-posts.js';

// Shared evaluated core, direct runtime transport. Monitoring intentionally omits
// optional rendering: unresolved contact is preferable to another browser bill.
export async function assessFeed(posts:Post[],storedIds:ReadonlySet<string>,credentials:{account:string;token:string},save:(value:unknown)=>Promise<void>){
  let calls=0;
  const prompts=await Promise.all(['find-hiring-opportunity.txt','extract-direct-contact.txt','identify-company.txt','verify-company-website.txt']
    .map(name=>readFile(new URL('./prompts/'+name,import.meta.url),'utf8')));
  const model=async(stage:string,prompt:string,value:unknown,schema:unknown)=>{
    if(calls>=60)throw Error('Model cap exhausted');calls++;
    const request={messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(value)}],temperature:0,max_completion_tokens:800,stream:false,store:false,
      chat_template_kwargs:{enable_thinking:false},response_format:{type:'json_schema',json_schema:{name:stage,strict:true,schema}}};
    if(Buffer.byteLength(JSON.stringify(request))>50000)throw Error('Model input cap');
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${credentials.account}/ai/run/${HIRING_MODEL}`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:`Bearer ${credentials.token}`,'Content-Type':'application/json'},body:JSON.stringify(request)});
    if(!response.ok)throw Error('Model request failed; no retry');
    const envelope=await response.json() as {success?:boolean;result?:{choices?:{message?:{content?:string}}[]}};
    const raw=envelope.result?.choices?.[0]?.message?.content;
    if(!envelope.success||typeof raw!=='string')throw Error('Missing model response');return raw;
  };
  const loader=createCompanyDiscoverySourceLoader({
    extractContact:value=>model('direct_contact',prompts[1]!,value,directContactJsonSchema),
    identifyCompany:value=>model('identify_company',prompts[2]!,value,companyIdentityJsonSchema),
    verifyWebsite:value=>model('verify_website',prompts[3]!,value,companyWebsiteJsonSchema),
  });
  const result=await runLeadFlow({posts,storedOpportunityIds:storedIds,maxModelCalls:60,
    classify:(_post,context)=>model('hiring_selection',prompts[0]!,context,hiringDecisionJsonSchema),loadSources:loader,
    enrich:async source=>JSON.stringify({source_post_id:source.id,company_name:null,company_source_ids:[],application_routes:[],needs_lookup:true,reason:'Contact unresolved.'}),save});
  return {opportunities:result.opportunities,stopped:result.stopped,modelCalls:calls,
    completedPostIds:result.rows.filter(r=>r.status!=='not_processed'&&r.status!=='error'&&r.hiring).map(r=>r.postId)};
}
