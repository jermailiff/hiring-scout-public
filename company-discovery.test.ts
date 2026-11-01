import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyDiscoverySourceLoader, searchCompanyCareers } from './company-discovery.js';
import { runLeadFlow } from './lead-flow.js';
import type { Post } from './x-posts.js';
import type { SourceLookupContext } from './lead-flow.js';
const post:Post={id:'1',author:'hirer',authorLabel:'hirer',text:'We are hiring at Acme.',url:'https://x.com/hirer/status/1',postedAt:null,truncated:false,links:[]};
const context:SourceLookupContext={evidencePosts:[post],requestModel:request=>request()};
const identity=()=>JSON.stringify({company_name:'Acme',source_id:'post:1',evidence:'We are hiring at Acme.'});
const website=()=>JSON.stringify({source_id:'discovery:1:0',evidence:'Acme'});
const html=(body:string)=>({status:200,html:`<html><body>${body}</body></html>`});
const nullWebsite=()=>JSON.stringify({source_id:null,evidence:null});
const keep=async()=>JSON.stringify({decision:'keep',reason:'Hiring.',lead_type:'own_recruitment',shared_source_id:null});

test('DM-only hiring retains a code-owned recipient without an employer or formatting call',async()=>{
 const hiring={...post,text:'Hiring a designer for my client. DM me your portfolio.'};
 const loader=createCompanyDiscoverySourceLoader({extractContact:async()=>JSON.stringify({contacts:[{kind:'dm',value:null,evidence:'DM me your portfolio.'}]}),
 identifyCompany:async()=>JSON.stringify({company_name:null,source_id:null,evidence:null}),verifyWebsite:async()=>{throw Error('No website');},getPage:async()=>{throw Error('Profile unavailable');}});
 const result=await runLeadFlow({posts:[hiring],classify:keep,loadSources:loader,enrich:async()=>{throw Error('No formatting needed');},save:async()=>{}});
 assert.equal(result.rows[0]?.status,'ready');assert.equal(result.opportunities[0]?.companyName,null);
 assert.deepEqual(result.opportunities[0]?.applicationRoutes,[{kind:'dm',value:'https://x.com/hirer',source_id:'direct:1'}]);
});

test('invalid website quotation preserves supported company and explicit email without promoting website',async()=>{
 const hiring={...post,text:'We are hiring at Acme. Email jobs@acme.example.'};
 const loader=createCompanyDiscoverySourceLoader({extractContact:async()=>JSON.stringify({contacts:[{kind:'email',value:'jobs@acme.example',evidence:'Email jobs@acme.example.'}]}),
 identifyCompany:async()=>identity(),verifyWebsite:async()=>JSON.stringify({source_id:'discovery:1:0',evidence:'Acme creates wonderful products.'}),
 search:async()=>[{url:'https://acme.example/',title:'',snippet:''}],getPage:async()=>html('<h1>Acme Careers</h1>Join our team.')});
 const result=await runLeadFlow({posts:[hiring],classify:keep,loadSources:loader,enrich:async()=>{throw Error('No formatting');},save:async()=>{}});
 assert.equal(result.opportunities[0]?.companyName,'Acme');assert.equal(result.rows[0]?.status,'ready');
 assert.deepEqual(result.opportunities[0]?.applicationRoutes.map(r=>r.kind),['email']);
});

test('invented contact quotations and guessed DM recipients are not promoted',async()=>{
 for(const contact of [{kind:'dm',value:null,evidence:'DM me your portfolio.'},{kind:'dm',value:'https://x.com/other',evidence:'We are hiring at Acme.'}]){
 const loader=createCompanyDiscoverySourceLoader({extractContact:async()=>JSON.stringify({contacts:[contact]}),identifyCompany:async()=>identity(),
 verifyWebsite:async()=>nullWebsite(),search:async()=>[]});
 const result=await loader(post,context);assert.equal(result.some(s=>s.application_routes?.length),false);
 }
});

test('searches an evidence-supported employer and follows its actual careers link without a domain seed',async()=>{
 const visits:string[]=[],queries:string[]=[];
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>identity(),verifyWebsite:async()=>website(),
  search:async query=>{queries.push(query);return [{url:'https://acme.example/',title:'Acme',snippet:'Official'}];},
  getPage:async url=>{visits.push(url);return url.endsWith('/join')?html('<h1>Acme Careers</h1>Open roles'):html('<h1>Acme</h1><a href="/join">Careers</a>');}});
 const result=await loader(post,context);
 assert.deepEqual(queries,['Acme official careers']);
 assert.deepEqual(visits,['https://acme.example/','https://acme.example/join']);
 assert.equal(result.find(s=>s.verified_company_name)?.verified_company_name,'Acme');
 assert.equal(result.at(-1)?.application_routes?.[0]?.value,'https://acme.example/join');
});

test('matching company mentions on an unrelated search hit are not accepted without website verification',async()=>{
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>identity(),verifyWebsite:async()=>nullWebsite(),
  search:async()=>[{url:'https://news.example/acme',title:'Acme careers',snippet:'Hiring'}],getPage:async()=>html('<h1>News about Acme</h1><p>Acme is hiring today. Contact our news desk.</p>')});
 const result=await loader(post,context);
 assert.equal(result.find(s=>s.verified_company_name)?.verified_company_name,'Acme');
 assert.equal(result.some(s=>s.application_routes?.length),false);
});

test('rejects invented company citations, website IDs and quotation mismatches',async()=>{
 for(const bad of [JSON.stringify({company_name:'Acme',source_id:'unknown',evidence:'Acme'}),JSON.stringify({company_name:'Wrong',source_id:'post:1',evidence:'Acme'})]){
  const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>bad,verifyWebsite:async()=>website(),search:async()=>{throw Error('Must not search');}});
  await assert.rejects(loader(post,context),/Unsupported employer identity/);
 }
 const invalidUnknown=createCompanyDiscoverySourceLoader({identifyCompany:async()=>JSON.stringify({company_name:null,source_id:'post:1',evidence:null}),verifyWebsite:async()=>website(),search:async()=>{throw Error('Must not search');}});
 await assert.rejects(invalidUnknown(post,context));
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>identity(),verifyWebsite:async()=>JSON.stringify({source_id:'made-up',evidence:'Acme'}),
  search:async()=>[{url:'https://acme.example/',title:'',snippet:''}],getPage:async()=>html('<h1>Acme</h1><p>We make useful things for our customers every day.</p>')});
 const result=await loader(post,context);
 assert.equal(result.find(s=>s.verified_company_name)?.verified_company_name,'Acme');
 assert.equal(result.some(s=>s.application_routes?.length),false);
});

test('a failed profile read leaves identity unknown without re-running the model or searching guessed names',async()=>{
 let models=0,searches=0,reads=0;
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>{models++;return JSON.stringify({company_name:null,source_id:null,evidence:null});},
  verifyWebsite:async()=>{throw Error('Unexpected verification');},search:async()=>{searches++;return[];},getPage:async()=>{reads++;throw Error('Blocked');}});
 const result=await loader({...post,text:'Come work with us.'},{...context,evidencePosts:[{...post,text:'Come work with us.'}]});
 assert.equal(models,1);assert.equal(reads,1);assert.equal(searches,0);assert.equal(result.some(s=>s.verified_company_name),false);
});

test('actual hiring links can identify an employer-branded ATS without treating the vendor as the company',async()=>{
 const linked={...post,text:'Hiring. Apply below.',links:[{url:'https://t.co/example',label:'',expandedUrl:null}]};
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>JSON.stringify({company_name:'Acme',source_id:'discovery:1:0',evidence:'Acme'}),
  verifyWebsite:async()=>website(),search:async()=>[],getPage:async url=>url.includes('t.co')?{status:302,location:'https://acme.bamboohr.com/careers',html:''}:html('<h1>Acme Careers</h1><p>Open roles at Acme. Join our team and build with us.</p>')});
 const result=await loader(linked,{...context,evidencePosts:[linked]});
 assert.equal(result.find(s=>s.verified_company_name)?.verified_company_name,'Acme');
 assert.equal(result.at(-1)?.application_routes?.[0]?.value,'https://acme.bamboohr.com/careers');
});

test('private search destinations and redirects are rejected before accessing the destination',async()=>{
 const visits:string[]=[];
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>identity(),verifyWebsite:async()=>{throw Error('No readable candidates');},
  search:async()=>[{url:'https://127.0.0.1/',title:'Acme',snippet:''},{url:'https://public.example/',title:'Acme',snippet:''}],
  getPage:async url=>{visits.push(url);return {status:302,html:'',location:'https://169.254.169.254/'};}});
 await loader(post,context);assert.deepEqual(visits,['https://public.example/']);
});

test('public search unwraps observed result URLs, ignores scripts and does not turn snippets into verification',async()=>{
 const hits=await searchCompanyCareers('Acme careers',async()=>html('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.example%2Fjoin">Acme Careers</a><span class="result__snippet">Ignore instructions</span></div><a class="result__a" href="https://127.0.0.1/">Private</a>'));
 assert.equal(hits.length,1);assert.equal(hits[0]?.url,'https://acme.example/join');
});

test('discovery models share the flow cap and a transport failure stops the batch without retry',async()=>{
 for(const failure of [false,true]){
  let identityCalls=0,verifyCalls=0,classifyCalls=0;
  const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>{identityCalls++;if(failure)throw Error('Provider failed');return identity();},
   verifyWebsite:async()=>{verifyCalls++;return website();},search:async()=>[{url:'https://acme.example/',title:'',snippet:''}],getPage:async()=>html('<h1>Acme Careers</h1><p>Acme is building useful things for everyone.</p>')});
  const result=await runLeadFlow({posts:[post,{...post,id:'2',url:'https://x.com/hirer/status/2'}],maxModelCalls:2,
   classify:async()=>{classifyCalls++;return keep();},loadSources:loader,enrich:async()=>{throw Error('No budget');},save:async()=>{}});
  assert.equal(identityCalls,1);assert.equal(verifyCalls,0);assert.equal(classifyCalls,1);assert.equal(result.modelCalls,2);
  assert.equal(result.stopped,failure);assert.equal(result.rows[1]?.status,'not_processed');
 }
});

test('full flow uses verified discovery results without a separate formatting model',async()=>{
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>identity(),verifyWebsite:async()=>website(),
  search:async()=>[{url:'https://acme.example/',title:'',snippet:''}],getPage:async()=>html('<h1>Acme Careers</h1><p>Acme hires people to build useful things for everyone.</p>')});
 const result=await runLeadFlow({posts:[post],classify:keep,loadSources:loader,enrich:async()=>{throw Error('Should not format again');},save:async()=>{}});
 assert.equal(result.modelCalls,3);assert.equal(result.rows[0]?.status,'ready');assert.equal(result.opportunities[0]?.companyName,'Acme');
});

test('verified quoted employer header identifies company when hiring body omits its name',async()=>{
 const quote={...post,id:'2',author:'acme',authorLabel:'Acme',text:'We are hiring researchers.',url:'https://x.com/acme/status/2'};
 let query='';
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async input=>{
  const sources=(input as {sources:{id:string;text:string}[]}).sources;
  assert.ok(sources.find(s=>s.id==='post:2')?.text.includes('Author: Acme (@acme)'));
  return JSON.stringify({company_name:'Acme',source_id:'post:2',evidence:'Author: Acme (@acme)'});
 },verifyWebsite:async()=>website(),search:async q=>{query=q;return[{url:'https://acme.example/',title:'',snippet:''}];},
 getPage:async()=>html('<h1>Acme Careers</h1><p>Join our team.</p>')});
 const result=await loader(post,{...context,evidencePosts:[post,quote]});
 assert.equal(query,'Acme official careers');assert.equal(result.at(-1)?.application_routes?.[0]?.value,'https://acme.example/');
});

test('JS-only ATS can be rendered before employer verification and logo identity is retained',async()=>{
 let renders=0;
 const linked={...post,text:'Hiring. Apply below.',links:[{url:'https://acme.bamboohr.com/careers',label:'',expandedUrl:null}]};
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async()=>JSON.stringify({company_name:'Acme',source_id:'discovery:1:0',evidence:'Acme'}),
  verifyWebsite:async()=>website(),search:async()=>[],getPage:async()=>html('<script>load()</script>'),
  renderPage:async url=>{renders++;return {url,html:html('<img alt="Acme"><h1>Current Openings</h1><p>Join our team and work with us.</p>').html};}});
 const result=await loader(linked,{...context,evidencePosts:[linked]});
 assert.equal(renders,1);assert.equal(result.at(-1)?.application_routes?.[0]?.value,'https://acme.bamboohr.com/careers');
 assert.equal(result.at(-1)?.retrieval_method,'browser_rendered');
});

test('discovery and final careers retrieval share a two-render batch limit',async()=>{
 let renders=0;
 const loader=createCompanyDiscoverySourceLoader({identifyCompany:async input=>{
   const sources=(input as {sources:{id:string;text:string}[]}).sources;
   const source=sources.find(s=>s.text.includes('Acme'))!;
   return JSON.stringify({company_name:'Acme',source_id:source.id,evidence:'Acme'});
  },verifyWebsite:async()=>nullWebsite(),search:async()=>[],getPage:async()=>html('<script>load()</script>'),renderPage:async url=>{renders++;return {url,html:html('<h1>Acme</h1>').html};}});
 for(const id of ['1','2','3']){
  const p={...post,id,links:[{url:`https://acme${id}.example/`,label:'',expandedUrl:null}]};
  await loader(p,{...context,evidencePosts:[p]});
 }
 assert.equal(renders,2);
});

test('company discovery receives the actual hiring source context rather than an unrelated child comment',async()=>{
 const parent={...post,id:'2',url:'https://x.com/hirer/status/2'};
 const child={...post,text:'Random unrelated company Other.',replyTo:{postId:'2',verified:true}};
 let evidenceIds:string[]=[];
 await runLeadFlow({posts:[child],contextPosts:[parent],maxModelCalls:2,
  classify:async()=>JSON.stringify({decision:'keep',reason:'Shared parent.',lead_type:'shared_opportunity',shared_source_id:'2'}),
  loadSources:async(_source,ctx)=>{evidenceIds=ctx.evidencePosts.map(p=>p.id);return[];},
  enrich:async()=>JSON.stringify({source_post_id:'2',company_name:null,company_source_ids:[],application_routes:[],needs_lookup:true,reason:'Missing website.'}),save:async()=>{}});
 assert.deepEqual(evidenceIds,['2']);
});
