import { z } from 'zod';
import { parseHTML } from 'linkedom';
import { createCareersSourceLoader, getPublicHtml, safePublicUrl } from './careers-lookup.js';
import type { LookupPage, VerifiedEmployer } from './careers-lookup.js';
import type { ContactSource } from './lead-contracts.js';
import type { SourceLookupContext } from './lead-flow.js';
import type { PostEvidence } from './x-posts.js';

const identitySchema = z.union([
  z.object({company_name:z.null(),source_id:z.null(),evidence:z.null()}).strict(),
  z.object({company_name:z.string().trim().min(2).max(100),source_id:z.string().min(1),evidence:z.string().min(1).max(600)}).strict(),
]);
const websiteSchema = z.union([
  z.object({source_id:z.null(),evidence:z.null()}).strict(),
  z.object({source_id:z.string().min(1),evidence:z.string().min(1).max(600)}).strict(),
]);
export const companyIdentityJsonSchema = z.toJSONSchema(identitySchema);
export const companyWebsiteJsonSchema = z.toJSONSchema(websiteSchema);
const directContactSchema=z.object({contacts:z.array(z.object({kind:z.enum(['dm','email']),value:z.string().nullable(),evidence:z.string().min(1).max(600)}).strict()).max(3)}).strict();
export const directContactJsonSchema=z.toJSONSchema(directContactSchema);
export interface SearchHit { url:string; title:string; snippet:string }
export interface DiscoveryEvent { stage:string; url?:string; query?:string; source?:ContactSource; detail?:string }
const normalize=(value:string)=>value.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const social=(host:string)=>/(?:^|\.)(?:x\.com|twitter\.com|linkedin\.com|facebook\.com|instagram\.com)$/.test(host);
function pageText(html:string) {
  const {document}=parseHTML(html);
  for(const node of document.querySelectorAll('script,style,noscript'))node.remove();
  return [...document.querySelectorAll('title')].map(n=>n.textContent??'').join(' ')+' '+
    [...document.querySelectorAll('img[alt]')].map(n=>n.getAttribute('alt')??'').join(' ')+' '+
    (document.body?.textContent??document.textContent??'').replace(/\s+/g,' ').trim();
}

// Public HTML search, no paid subscription, API key, cookies or model guesses.
// This endpoint can block automation; an unavailable search stays unresolved.
export async function searchCompanyCareers(query:string, getPage=getPublicHtml):Promise<SearchHit[]> {
  const page=await getPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if(page.status!==200)throw Error('Search unavailable');
  const {document}=parseHTML(page.html);
  const hits:SearchHit[]=[];
  for(const anchor of document.querySelectorAll('a.result__a')) {
    try {
      let url=new URL(anchor.getAttribute('href')!,'https://html.duckduckgo.com');
      if(url.hostname.endsWith('duckduckgo.com')&&url.searchParams.has('uddg'))url=new URL(url.searchParams.get('uddg')!);
      url=safePublicUrl(url.href);
      if(social(url.hostname)||url.hostname.endsWith('duckduckgo.com'))continue;
      if(hits.some(h=>h.url===url.href))continue;
      hits.push({url:url.href,title:anchor.textContent??'',snippet:anchor.closest('.result')?.querySelector('.result__snippet')?.textContent??''});
      if(hits.length===3)break;
    } catch { /* Search prose/URLs are untrusted. */ }
  }
  return hits;
}

export function createCompanyDiscoverySourceLoader(options:{
  identifyCompany:(input:unknown)=>Promise<string>;
  verifyWebsite:(input:unknown)=>Promise<string>;
  extractContact?:(input:unknown)=>Promise<string>;
  search?:(query:string)=>Promise<SearchHit[]>;
  getPage?:(url:string)=>Promise<LookupPage>;
  renderPage?:(url:string,signal:AbortSignal)=>Promise<{url:string;html:string}>;
  audit?:(event:DiscoveryEvent)=>Promise<void>;
}) {
  const getPage=options.getPage??getPublicHtml;
  let totalReads=0,totalSearches=0,renderedPages=0;
  const fetched=new Map<string,LookupPage>();
  const render=options.renderPage?async(url:string,signal:AbortSignal)=>{
    if(renderedPages>=2)throw Error('Shared render budget exhausted');
    renderedPages++;await audit({stage:'render_reserved',url});return options.renderPage!(url,signal);
  }:undefined;
  const employers=new Map<string,VerifiedEmployer>();
  // Final careers retrieval retains the original shared 12-operation/2-render cap.
  const careers=createCareersSourceLoader(employers,{getPage:url=>fetched.has(url)?Promise.resolve(fetched.get(url)!):getPage(url),...(render?{renderPage:render}:{})});
  const audit=options.audit??(async()=>{});
  return async(post:PostEvidence,context:SourceLookupContext):Promise<ContactSource[]>=>{
    const evidence:ContactSource[]=context.evidencePosts.filter(p=>!p.truncated).map(p=>({id:`post:${p.id}`,url:p.url,
      text:`Author: ${p.authorLabel||p.author} (@${p.author})\n${p.text}\nLinks: ${JSON.stringify(p.links)}`.slice(0,6000)}));
    const retrieved:ContactSource[]=[];
    // Only the selected hiring post may offer a direct route here. Connected
    // speakers' addresses and profile sales contacts must not leak into it.
    if(options.extractContact){
      const raw=await context.requestModel(()=>options.extractContact!({author:post.author,text:post.text}));
      try{
        const answer=directContactSchema.parse(JSON.parse(raw));
        const routes:NonNullable<ContactSource['application_routes']>=[];
        for(const contact of answer.contacts){
          if(!post.text.includes(contact.evidence))throw Error('Unsupported contact quotation');
          if(contact.kind==='dm'){
            // Model judges hiring purpose; code owns the captured author's URL.
            if(contact.value!==null||!/^\w{1,15}$/.test(post.author))throw Error('Unsupported DM recipient');
            routes.push({kind:'dm',value:`https://x.com/${post.author}`});
          }else{
            if(!contact.value||!contact.evidence.includes(contact.value)||!/^\S+@\S+\.\S+$/.test(contact.value))throw Error('Unsupported email');
            routes.push({kind:'email',value:contact.value});
          }
        }
        if(routes.length)evidence.push({id:`direct:${post.id}`,url:post.url,text:post.text,application_routes:routes});
      }catch{await audit({stage:'direct_contact_rejected',detail:'Invalid contact output; no route promoted.'});}
    }
    let reads=0,rendered=false;
    const cache=new Map<string,{source:ContactSource;html:string}>();
    const read=async(initial:string,stage:string)=>{
      let url=safePublicUrl(initial);
      for(let hop=0;hop<3;hop++) {
        if(reads>=6||totalReads>=18)throw Error('Discovery HTTP budget exhausted');
        const cached=cache.get(url.href);if(cached)return cached;
        reads++;totalReads++;await audit({stage:`${stage}_reserved`,url:url.href});
        let page=await getPage(url.href);
        if([301,302,303,307,308].includes(page.status)&&page.location){url=safePublicUrl(new URL(page.location,url).href);continue;}
        if(page.status!==200||Buffer.byteLength(page.html)>524288)throw Error('Unreadable discovery page');
        const text=pageText(page.html);
        if(/captcha|verify (?:that )?you are human|access denied|checking your browser/i.test(text))throw Error('Blocked discovery page');
        if(render&&!rendered&&renderedPages<2&&!social(url.hostname)&&(text.trim().length<80||/(?:enable|requires?) javascript/i.test(text))){
          rendered=true;const signal=AbortSignal.timeout(30000);
          const result=await Promise.race([render(url.href,signal),new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Discovery render timeout')),{once:true}))]);
          const destination=safePublicUrl(result.url);
          if(destination.hostname!==url.hostname||Buffer.byteLength(result.html)>524288)throw Error('Untrusted discovery render');
          page={status:200,html:result.html,retrievalMethod:'browser_rendered'};
        }
        const source:ContactSource={id:`discovery:${post.id}:${retrieved.length}`,url:url.href,text:pageText(page.html).slice(0,6000),retrieval_method:page.retrievalMethod??'http'};
        if(/captcha|verify (?:that )?you are human|access denied|checking your browser/i.test(source.text))throw Error('Blocked discovery page');
        retrieved.push(source);await audit({stage,url:url.href,source});
        fetched.set(url.href,page);
        const result={source,html:page.html};cache.set(url.href,result);return result;
      }
      throw Error('Discovery redirect cap');
    };
    // Start only with an actual captured external hiring link. Never guess a URL
    // from a tenant slug or use a search result as employer verification.
    const link=post.links.find(l=>{try{return !social(safePublicUrl(l.expandedUrl??l.url).hostname);}catch{return false;}});
    if(link){try{await read(link.expandedUrl??link.url,'hiring_link');}catch{await audit({stage:'hiring_link_unavailable'});}}
    const identify=async()=>{
      const sources=[...evidence,...retrieved];
      const answer=identitySchema.parse(JSON.parse(await context.requestModel(()=>options.identifyCompany({post_id:post.id,sources}))));
      if(answer.company_name===null){if(answer.source_id!==null||answer.evidence!==null)throw Error('Invalid unknown identity');return null;}
      const source=sources.find(s=>s.id===answer.source_id);
      if(!source||!answer.evidence||!source.text.includes(answer.evidence)||!normalize(answer.evidence).includes(normalize(answer.company_name)))throw Error('Unsupported employer identity');
      return {name:answer.company_name,source};
    };
    let identity=await identify();
    if(!identity) {
      // One bounded profile read only after the actual hiring sources lack a name.
      try {await read(`https://x.com/${encodeURIComponent(post.author)}`,'author_profile');}
      catch {return [...evidence,...retrieved];}
      identity=await identify();
    }
    if(!identity)return [...evidence,...retrieved];
    // Employer identity and official website ownership are separate claims.
    evidence.push({...identity.source,id:`identity:${post.id}`,verified_company_name:identity.name});
    const candidates:ContactSource[]=retrieved.filter(s=>!social(new URL(s.url).hostname)&&s.text.trim().length>0);
    // Search from the evidence-supported company name, not a supplied domain map.
    if(totalSearches<4) {
      totalSearches++;const query=`${identity.name} official careers`;
      await audit({stage:'search_reserved',query});
      try {
        const hits=await(options.search??searchCompanyCareers)(query);
        for(const hit of hits.slice(0,3)) {
          try {
            const url=safePublicUrl(hit.url);if(social(url.hostname))continue;
            const page=await read(url.href,'search_candidate');
            if(!candidates.some(s=>s.id===page.source.id))candidates.push(page.source);
          } catch { /* No retries or fallthrough to an invented URL. */ }
        }
      } catch {await audit({stage:'search_unavailable',query});}
    }
    if(!candidates.length)return [...evidence,...retrieved];
    const rawVerification=await context.requestModel(()=>options.verifyWebsite({company_name:identity.name,
      hiring_evidence:identity.source,candidate_websites:candidates}));
    let verification:z.infer<typeof websiteSchema>;
    try{verification=websiteSchema.parse(JSON.parse(rawVerification));}
    catch{await audit({stage:'website_verification_rejected',detail:'Invalid website output; supported identity/contact retained.'});return [...evidence,...retrieved];}
    if(verification.source_id===null){if(verification.evidence!==null)throw Error('Invalid rejected website');return [...evidence,...retrieved];}
    const website=candidates.find(s=>s.id===verification.source_id);
    if(!website||!verification.evidence||!website.text.includes(verification.evidence)||!normalize(verification.evidence).includes(normalize(identity.name))){
      await audit({stage:'website_verification_rejected',detail:'Unsupported exact website quotation; supported identity/contact retained.'});
      return [...evidence,...retrieved];
    }
    await audit({stage:'website_verified',source:website,detail:'Model-assisted ownership assessment with exact retrieved identity quote; not deterministic proof of ownership.'});
    employers.set(post.id,{companyName:identity.name,officialUrl:website.url,identitySource:{...website,
      id:`employer:${post.id}`,text:`Hiring evidence: ${identity.source.text}\nRetrieved website evidence: ${website.text}`.slice(0,16000)}});
    // Reuse fetched HTML, rather than reading a known page twice.
    // createCareersSourceLoader has its own shared caps and validates actual links.
    const result=await careers(post);
    for(const source of result)await audit({stage:'careers_source',source});
    return [...evidence,...retrieved,...result];
  };
}
