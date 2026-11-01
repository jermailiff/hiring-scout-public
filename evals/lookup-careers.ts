import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {createCloudflareCareersRenderer} from '../cloudflare-careers-renderer.js';
import { createCareersSourceLoader, getPublicHtml } from '../careers-lookup.js';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: lookup-careers PRIVATE_VERIFIED_EMPLOYERS_JSON NEW_REPORT_JSON');
const seed=z.array(z.object({sourceId:z.string().min(1),companyName:z.string().min(1),officialUrl:z.string().url(),
 identitySource:z.object({id:z.string().min(1),url:z.string().url(),text:z.string().min(1)})}).strict()).max(12).parse(JSON.parse(await readFile(input,'utf8')));
if(new Set(seed.map(s=>s.sourceId)).size!==seed.length)throw Error('Duplicate source IDs');
const renderEnabled=process.env.CAREERS_RENDERER==='cloudflare';
const rendererDiagnostics:unknown[]=[];
const renderPage=renderEnabled?createCloudflareCareersRenderer({accountId:process.env.CLOUDFLARE_ACCOUNT_ID??'',apiToken:process.env.CLOUDFLARE_API_TOKEN??'',allowedHosts:seed.map(s=>new URL(s.officialUrl).hostname),onDiagnostic:event=>{rendererDiagnostics.push(event);}}):undefined;
await mkdir(dirname(output),{recursive:true,mode:0o700});
// Exclusive creation before requests; never overwrite an uncertain prior run.
const report:{mode:string;newModelCalls:number;requests:number;qualification:string;rows:unknown[];rendererDiagnostics:unknown[]}={mode:'verified_employer_careers_lookup',newModelCalls:0,requests:0,
 qualification:`Employer identity/official seeds supplied from prior verification, not automatically inferred. Bounded live HTTP lookup; ${renderEnabled?'explicit Cloudflare rendering fallback enabled':'no browser fallback enabled'}. Network failures retain unknown routes.`,rows:[],rendererDiagnostics};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const loader=createCareersSourceLoader(new Map(seed.map(s=>[s.sourceId,s])),{...(renderPage?{renderPage}:{}),getPage:async url=>{report.requests++;await save();return getPublicHtml(url);}});
for(const item of seed){
 const sources=await loader({id:item.sourceId,url:item.identitySource.url,author:'',authorLabel:'',text:'',links:[],postedAt:null,truncated:false});
 const routes=sources.flatMap(s=>(s.application_routes??[]).map(r=>({...r,source_id:s.id})));
 report.rows.push({sourceId:item.sourceId,companyName:item.companyName,applicationRoutes:routes,needsLookup:routes.length===0,sources});await save();
}
console.log(JSON.stringify({requests:report.requests,newModelCalls:0,report:output}));
