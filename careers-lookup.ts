import { request } from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { parseHTML } from 'linkedom';
import type { ContactSource } from './lead-contracts.js';
import type { PostEvidence } from './x-posts.js';

// Trusted, privately supplied identity evidence, not an unverified model guess.
export interface VerifiedEmployer {
  companyName: string;
  officialUrl: string;
  identitySource: ContactSource;
}
export interface LookupPage { status: number; html: string; location?: string; retrievalMethod?: 'browser_rendered' }
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(network,prefix);
export const publicIpv4 = (ip: string) => isIP(ip) === 4 && !blocked.check(ip, 'ipv4');
export function safePublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || isIP(url.hostname) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) throw Error('Unsafe destination');
  url.hash = '';return url;
}
const safeUrl = safePublicUrl;
// No cookies/auth, JS execution, form submission, automatic redirects or retries.
// Resolve IPv4 at connection time and reject private/reserved addresses.
export function getPublicHtml(url: string): Promise<LookupPage> {
  const target = safeUrl(url);
  return new Promise((resolve,reject) => {
    const req = request(target, { method:'GET', family:4, headers:{Accept:'text/html', 'User-Agent':'HiringScout/0.1 careers lookup'},
      signal:AbortSignal.timeout(8000), lookup:(host,_options,callback) => {
        lookup(host,{family:4},(error,address,family) => {
          if (error) return callback(error,'',4);
          if (!publicIpv4(address)) return callback(Error('Non-public destination'),'',4);
          callback(null,address,family);
        });
      } }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.destroy(); resolve({status,html:'',...(res.headers.location ? {location:res.headers.location} : {})});return; }
      if (status !== 200 || !/text\/html/i.test(res.headers['content-type'] ?? '')) {res.destroy();reject(Error('Unavailable HTML page'));return;}
      let bytes=0;const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>524288){res.destroy(Error('Page too large'));}else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>resolve({status,html:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);req.end();
  });
}
const isCareers = (text:string) => /\b(?:careers?|jobs?|current openings|open positions|open roles|join (?:our|the) team)\b/i.test(text);
const ats = (host:string) => /^(?:[a-z0-9-]+\.bamboohr\.com|jobs\.ashbyhq\.com|(?:job-boards|boards)\.greenhouse\.io|jobs\.lever\.co|[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com)$/.test(host);

export function createCareersSourceLoader(employers: ReadonlyMap<string,VerifiedEmployer>, options: {
  getPage?: (url:string)=>Promise<LookupPage>; maxRequests?:number;
  renderPage?: (url:string, signal:AbortSignal)=>Promise<{url:string;html:string}>;
  maxRenderedPages?:number;
} = {}) {
  let requests=0, renderedPages=0;
  const limit=options.maxRequests ?? 12;
  if (!Number.isInteger(limit)||limit<0||limit>12) throw Error('Lookup request cap must be 0–12');
  const renderLimit=options.maxRenderedPages ?? 2;
  if(!Number.isInteger(renderLimit)||renderLimit<0||renderLimit>2)throw Error('Render cap must be 0–2');
  const getPage=options.getPage ?? getPublicHtml;
  return async (post:PostEvidence):Promise<ContactSource[]> => {
    const employer=employers.get(post.id);
    if (!employer) return []; // No employer identity guess or arbitrary web search.
    const official=safeUrl(employer.officialUrl);
    const identity=employer.identitySource;
    if (!employer.companyName.trim() || !identity.id || !identity.text.trim()) throw Error('Missing verified employer evidence');
    let used=0, rendered=false;
    const pages:ContactSource[]=[{...identity,verified_company_name:employer.companyName}];
    const allowed=new Set([official.hostname]);
    const visited=new Set<string>();
    const read = async (initial:string):Promise<{url:URL;html:string;rendered?:boolean}> => {
      let url=safeUrl(initial);
      for(let hop=0;hop<3;hop++) {
        if (!allowed.has(url.hostname) || visited.has(url.href)) throw Error('Untrusted redirect or loop');
        if (used>=4 || requests>=limit) throw Error('Careers lookup budget exhausted');
        visited.add(url.href);used++;requests++; // Reserve even on uncertain failures.
        const page=await getPage(url.href);
        if(page.status===200) {
          if(Buffer.byteLength(page.html)>524288)throw Error('Page too large');
          const {document}=parseHTML(page.html);
          for(const n of document.querySelectorAll('script,style,noscript'))n.remove();
          const text=(document.body?.textContent ?? '').replace(/\s+/g,' ').trim();
          const title=[...document.querySelectorAll('title,h1,h2')].map(n=>n.textContent??'').join(' ');
          const blocked=/verify (?:that )?you are human|checking your browser|access denied|captcha|sign in to continue/i.test(text);
          const thin=!isCareers(title) && (text.length<80 || /(?:enable|requires?) javascript/i.test(text));
          if(!blocked && thin && page.retrievalMethod!=='browser_rendered' && options.renderPage && !rendered && renderedPages<renderLimit && used<4 && requests<limit){
            rendered=true;renderedPages++;used++;requests++;
            const signal=AbortSignal.timeout(30000);
            const result=await Promise.race([options.renderPage(url.href,signal),new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Render timeout')),{once:true}))]);
            const destination=safeUrl(result.url);
            if(!allowed.has(destination.hostname)||Buffer.byteLength(result.html)>524288)throw Error('Unsafe rendered destination/content');
            return {url:destination,html:result.html,rendered:true};
          }
          return {url,html:page.html,...(page.retrievalMethod==='browser_rendered'?{rendered:true}:{})};
        }
        if(![301,302,303,307,308].includes(page.status)||!page.location) throw Error('Unavailable careers page');
        url=safeUrl(new URL(page.location,url).href);
      }
      throw Error('Redirect limit reached');
    };
    const evidence = ({url,html,rendered}:{url:URL;html:string;rendered?:boolean}, eligible:boolean):ContactSource => {
      const {document}=parseHTML(html);
      for(const n of document.querySelectorAll('script,style,noscript')) n.remove();
      const title=[...document.querySelectorAll('title,h1,h2')].map(n=>n.textContent ?? '').join(' ');
      const hiringPage=isCareers(title) || (ats(url.hostname) && isCareers(document.body?.textContent ?? ''));
      const individualJob=/\/(?:careers|jobs?)\/[^/]+/i.test(url.pathname)
        || (/^(?:jobs\.ashbyhq\.com|jobs\.lever\.co)$/.test(url.hostname) && url.pathname.split('/').filter(Boolean).length>1)
        || /"@type"\s*:\s*"JobPosting"/i.test(html);
      return {id:`careers:${post.id}:${pages.length}`,url:url.href,text:(document.body?.textContent ?? document.textContent ?? '').replace(/\s+/g,' ').slice(0,16000),
        retrieval_method:rendered ? 'browser_rendered' : 'http',
        application_routes:eligible && hiringPage && !individualJob ? [{kind:'careers_page',value:url.href}] : []};
    };
    try {
      const home=await read(official.href);
      const homeSource=evidence(home,true);pages.push(homeSource);
      if(homeSource.application_routes?.length) return pages;
      const {document}=parseHTML(home.html);
      // Only follow links the verified employer actually publishes. No guessed /careers path.
      const links=[...document.querySelectorAll('a[href]')].filter(a=> !a.closest('script,style,noscript') && isCareers(a.textContent ?? ''));
      for(const a of links.slice(0,6)) {
        let url:URL;
        try {url=safeUrl(new URL(a.getAttribute('href')!,home.url).href);} catch {continue;}
        if (url.hostname!==official.hostname && !ats(url.hostname)) continue;
        allowed.add(url.hostname); // ATS allowed only when directly linked by this employer.
        try {
          const page=await read(url.href);const source=evidence(page,true);pages.push(source);
          if(source.application_routes?.length) break;
        } catch { /* Preserve identity; no retry of failed URL. */ }
        if(used>=4||requests>=limit) break;
      }
    } catch { /* Unknown route remains lookup_needed in the existing flow. */ }
    return pages;
  };
}
