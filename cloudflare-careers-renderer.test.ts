import test from 'node:test';import assert from 'node:assert/strict';
import{createCloudflareCareersRenderer,CareersRendererError}from'./cloudflare-careers-renderer.js';
test('direct renderer returns HTML to caller without a chat-sized output boundary',async()=>{
 let calls=0;const html='<html><body>'+('x'.repeat(40000))+'</body></html>';
 const render=createCloudflareCareersRenderer({accountId:'a'.repeat(32),apiToken:'test-only',allowedHosts:['employer.example'],fetcher:async(input,init)=>{calls++;assert.match(String(input),/api.cloudflare.com/);assert.equal(init?.redirect,'error');return new Response(JSON.stringify({success:true,result:html}));}});
 assert.equal((await render('https://employer.example/',new AbortController().signal)).html,html);assert.equal(calls,1);
 await assert.rejects(render('https://other.example/',new AbortController().signal),/Unapproved/);assert.equal(calls,1);
});
test('provider timeout details survive failure without retry and credentials are redacted',async()=>{
 let calls=0;const events:unknown[]=[];
 const render=createCloudflareCareersRenderer({accountId:'a'.repeat(32),apiToken:'secret-value',allowedHosts:['employer.example'],onDiagnostic:event=>{events.push(event);},
  fetcher:async(_url,init)=>{calls++;const body=JSON.parse(init!.body as string);assert.equal(body.gotoOptions.waitUntil,'domcontentloaded');assert.deepEqual(body.waitForSelector,{selector:'h1',visible:true,timeout:5000});return new Response(JSON.stringify({success:false,errors:[{code:6002,message:'Timeout secret-value'}]}),{status:422});}});
 await assert.rejects(render('https://employer.example/',new AbortController().signal),error=>{
  assert.ok(error instanceof CareersRendererError);assert.equal(error.diagnostic.phase,'provider');assert.equal(error.diagnostic.httpStatus,422);
  assert.equal(error.diagnostic.providerErrors?.[0]?.code,6002);assert.ok(!JSON.stringify(error.diagnostic).includes('secret-value'));return true;
 });
 assert.equal(calls,1);assert.equal(events.length,1);
});
test('invalid JSON and request cancellation remain distinguishable from upstream timeouts',async()=>{
 const badJson=createCloudflareCareersRenderer({accountId:'a'.repeat(32),apiToken:'test-only',allowedHosts:['employer.example'],fetcher:async()=>new Response('bad-json')});
 await assert.rejects(badJson('https://employer.example/',new AbortController().signal),error=>error instanceof CareersRendererError&&error.diagnostic.phase==='response_json');
 const abort=createCloudflareCareersRenderer({accountId:'a'.repeat(32),apiToken:'test-only',allowedHosts:['employer.example'],fetcher:async()=>{throw new DOMException('Cancelled','AbortError');}});
 await assert.rejects(abort('https://employer.example/',new AbortController().signal),error=>error instanceof CareersRendererError&&error.diagnostic.phase==='request');
});
test('direct renderer does not retry failed or exhausted requests',async()=>{
 let calls=0;const render=createCloudflareCareersRenderer({accountId:'a'.repeat(32),apiToken:'test-only',allowedHosts:['employer.example'],fetcher:async()=>{calls++;return new Response('',{status:403});}});
 for(let i=0;i<3;i++)await assert.rejects(render('https://employer.example/',new AbortController().signal));assert.equal(calls,2);
});
