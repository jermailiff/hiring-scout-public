// Direct application transport. Chat's OAuth connection is not an API credential
// that can be exported into a Node process. Never log this configuration.
export interface RendererDiagnostic {
 phase:'complete'|'request'|'provider'|'response_json'|'content_validation';
 elapsedMs:number;
 httpStatus?:number;
 providerErrors?:{code:number;message:string}[];
 message?:string;
}
export class CareersRendererError extends Error {
 constructor(public readonly diagnostic:RendererDiagnostic) {
  super(`Careers renderer ${diagnostic.phase}: ${diagnostic.message??'failed'}; ${diagnostic.elapsedMs}ms; no retry`);
  this.name='CareersRendererError';
 }
}
// Shared with diagnostic runners so a connector test cannot silently use a
// different readiness condition from the direct application transport.
export function careersRenderRequest(url:string) {
 return {url,gotoOptions:{waitUntil:'domcontentloaded',timeout:15000},actionTimeout:5000,
  rejectResourceTypes:['image','media','font'],waitForSelector:{selector:'h1',visible:true,timeout:5000}};
}
export function createCloudflareCareersRenderer(options:{accountId:string;apiToken:string;allowedHosts:readonly string[];fetcher?:typeof fetch;
 onDiagnostic?:(event:RendererDiagnostic)=>void|Promise<void>}) {
 if(!/^[a-f0-9]{32}$/.test(options.accountId)||!options.apiToken)throw Error('Missing Cloudflare rendering credentials');
 let calls=0;
 return async(url:string,signal:AbortSignal):Promise<{url:string;html:string}>=>{
  const target=new URL(url);
  if(target.protocol!=='https:'||target.username||target.password||target.port||!options.allowedHosts.includes(target.hostname))throw Error('Unapproved rendering destination');
  if(signal.aborted||calls>=2)throw Error('Rendering cancelled or budget exhausted');
  calls++;
  const started=Date.now();let status:number|undefined;
  const clean=(value:string)=>value.replaceAll(options.apiToken,'[redacted]').slice(0,600);
  const fail=(phase:RendererDiagnostic['phase'],message:string,providerErrors?:{code:number;message:string}[])=>new CareersRendererError({phase,elapsedMs:Date.now()-started,
   ...(status!==undefined?{httpStatus:status}:{}),message:clean(message),...(providerErrors?{providerErrors}:{})});
  let diagnostic:RendererDiagnostic|undefined;
  try {
   const response=await(options.fetcher??fetch)(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/browser-rendering/content?cacheTTL=0`,{
    method:'POST',signal,redirect:'error',headers:{Authorization:`Bearer ${options.apiToken}`,'Content-Type':'application/json'},body:JSON.stringify(careersRenderRequest(target.href))});
   status=response.status;
   let data:{success?:boolean;result?:unknown;errors?:unknown};
   try{data=await response.json() as typeof data;}
   catch{throw fail(response.ok?'response_json':'provider',`HTTP ${status}; response body is not valid JSON`);}
   if(!response.ok||!data?.success){
    const errors=Array.isArray(data?.errors)?data.errors.flatMap((item:unknown)=>{
     if(typeof item!=='object'||item===null)return[];
     const e=item as {code?:unknown;message?:unknown};
     return typeof e.code==='number'&&typeof e.message==='string'?[{code:e.code,message:clean(e.message)}]:[];
    }).slice(0,5):[];
    throw fail('provider',`HTTP ${status}; ${errors.map(e=>`${e.code}: ${e.message}`).join('; ')||'provider reported failure'}`,errors);
   }
   if(typeof data.result!=='string'||Buffer.byteLength(data.result)>524288)throw fail('content_validation','Invalid or oversized rendered HTML');
   diagnostic={phase:'complete',elapsedMs:Date.now()-started,httpStatus:status};
   return{url:target.href,html:data.result};
  }catch(error){
   const failure=error instanceof CareersRendererError?error:fail('request',String(error));
   diagnostic=failure.diagnostic;throw failure;
  }finally{if(diagnostic)await options.onDiagnostic?.(diagnostic);}
 };
}
