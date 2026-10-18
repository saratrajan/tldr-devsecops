// Shared sanitizer + linter for edition payloads. Used by publish-feed.js and lint-feed.js.
const {storiesIn,computeCounts}=require('../../www/js/shared.js');

// Link policy. TLDR story short links (https://links.tldrnewsletter.com/<code>) are kept as they are.
// Every other tldrnewsletter.com host is blocked on purpose: a.tldrnewsletter.com serves the web-version and
// unsubscribe links, which carry signed subscriber tokens. Referral, sponsor and job hosts are blocked too.
const SHORT_HOST='links.tldrnewsletter.com';
const SHORT_PATH=/^\/[A-Za-z0-9]{4,12}$/;
const BLOCKED_HOSTS=[/(^|\.)tldrnewsletter\.com$/i,/(^|\.)refer\.tldr\.tech$/i,/(^|\.)sparklp\.co$/i,/(^|\.)advertise\.tldr\.tech$/i,/(^|\.)jobs\.ashbyhq\.com$/i];
// Returns "" when the URL object is acceptable, else a short reason.
function urlProblem(x){
  const h=x.hostname.toLowerCase();
  if(h===SHORT_HOST)return SHORT_PATH.test(x.pathname)&&!x.search&&!x.hash?"":"TLDR short link must be /<code> with no query or fragment";
  if(BLOCKED_HOSTS.some(r=>r.test(h)))return "tracker host "+h;
  return "";
}
const TRACK_PARAM=/^(utm_.+|fbclid|gclid|mc_cid|mc_eid|sp|ref|ref_src|igshid)$/i;
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const BAD_WORDS=/unsubscribe|manage your subscription|refer\.tldr|sparklp/i;
const CAT_ART=["a1","a2","a3"], PRI=["critical","high","watch"], TILES=["t1","t2","t3","t4","t5"];

const clean=s=>String(s==null?"":s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"").replace(/\s+/g," ").trim();

// Returns a safe https URL, or "" when the link is a tracker or invalid. TLDR short links pass unchanged.
function cleanUrl(u){
  u=clean(u);if(!u)return "";
  let x;try{x=new URL(u)}catch(_){return ""}
  if(x.protocol==="http:")x.protocol="https:";
  if(x.protocol!=="https:")return "";
  if(x.username||x.password)return "";
  if(urlProblem(x))return "";
  if(x.hostname.toLowerCase()===SHORT_HOST)return x.toString();
  for(const k of [...x.searchParams.keys()])if(TRACK_PARAM.test(k))x.searchParams.delete(k);
  return x.toString().replace(/\?$/,"");
}
const S=(o,k)=>clean(o&&o[k]);
const U=(o,k)=>cleanUrl(o&&o[k]);

function sanitizePage(p){
  if(!p||typeof p!=="object")return null;
  const base={type:p.type,tag:S(p,"tag")};
  if(p.type==="article")return {...base,art:CAT_ART.includes(p.art)?p.art:"a1",big:S(p,"big"),kicker:S(p,"kicker"),h:S(p,"h"),p:S(p,"p"),s:S(p,"s"),u:U(p,"u"),src:S(p,"src"),u2:U(p,"u2"),l2:S(p,"l2")};
  if(p.type==="list")return {...base,dark:!!p.dark,title:S(p,"title"),items:(Array.isArray(p.items)?p.items:[]).slice(0,5).map(i=>({pr:PRI.includes(i&&i.pr)?i.pr:"watch",h:S(i,"h"),d:S(i,"d"),u:U(i,"u")}))};
  if(p.type==="grid")return {...base,alt:!!p.alt,title:S(p,"title"),tiles:(Array.isArray(p.tiles)?p.tiles:[]).slice(0,5).map((t,i)=>({c:TILES.includes(t&&t.c)?t.c:TILES[i%5],k:S(t,"k"),t:S(t,"t"),d:S(t,"d"),u:U(t,"u")}))};
  return null;
}
function sanitize(ed){
  const P=(Array.isArray(ed&&ed.P)?ed.P:[]).filter(p=>p&&p.type!=="cover").map(sanitizePage).filter(Boolean);
  const TOP=(Array.isArray(ed&&ed.TOP)?ed.TOP:[]).slice(0,6).map(t=>[clean(t&&t[0]),parseInt(t&&t[1],10)]);
  const {counts,total}=computeCounts(P);   // incoming counts are ignored; always recomputed from the pages
  return {version:1,date:clean(ed&&ed.date),source:ed&&ed.source==="fallback"?"fallback":"gmail",counts,total,TOP,P};
}

const CAPS={tag:60,big:14,kicker:60,h:140,p:620,s:520,title:80,src:80,l2:40,d:340,k:30,t:110};
function lint(ed){
  const errors=[],warnings=[];
  const err=m=>errors.push(m),warn=m=>warnings.push(m);
  if(!ed||typeof ed!=="object")return {ok:false,errors:["not an object"],warnings};
  const allowed=["version","date","source","counts","total","TOP","P"];
  Object.keys(ed).forEach(k=>{if(!allowed.includes(k))err("unknown top-level key: "+k)});
  if(ed.version!==1)err("version must be 1");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(ed.date||"")||isNaN(Date.parse(ed.date)))err("date must be a real YYYY-MM-DD");
  if(!["gmail","fallback"].includes(ed.source))err("source must be gmail or fallback");
  if(ed.counts!==undefined||ed.total!==undefined){      // optional on old days, validated when present
    const keys=["tldr","it","devops","infosec"],c=ed.counts;
    if(!c||typeof c!=="object"||Array.isArray(c)||Object.keys(c).sort().join()!==[...keys].sort().join())err("counts needs exactly tldr, it, devops, infosec");
    else keys.forEach(k=>{if(!Number.isInteger(c[k])||c[k]<0||c[k]>60)err(`counts.${k} must be an integer 0..60`)});
    if(!Number.isInteger(ed.total)||ed.total<0||ed.total>60)err("total must be an integer 0..60");
    if(Array.isArray(ed.P)&&c&&typeof c==="object"){
      const calc=computeCounts(ed.P);
      if(ed.total!==calc.total||keys.some(k=>c[k]!==calc.counts[k]))err("counts or total do not match the pages");
    }
  }
  if(!Array.isArray(ed.P)||ed.P.length<1||ed.P.length>12)err("P needs 1 to 12 pages");
  if(!Array.isArray(ed.TOP)||ed.TOP.length<1||ed.TOP.length>6)err("TOP needs 1 to 6 entries");
  const nP=Array.isArray(ed.P)?ed.P.length:0;
  (ed.TOP||[]).forEach((t,i)=>{
    if(!Array.isArray(t)||typeof t[0]!=="string"||!t[0])err(`TOP[${i}] needs a headline`);
    else if(t[0].length>140)warn(`TOP[${i}] headline is long`);
    if(!Number.isInteger(t&&t[1])||t[1]<1||t[1]>nP)err(`TOP[${i}] page number must be 1..${nP}`)});
  const cap=(where,k,v)=>{if(typeof v==="string"&&CAPS[k]&&v.length>CAPS[k]*2)err(`${where}.${k} too long (${v.length})`);else if(typeof v==="string"&&CAPS[k]&&v.length>CAPS[k])warn(`${where}.${k} long (${v.length}/${CAPS[k]})`)};
  const need=(where,o,ks)=>ks.forEach(k=>{if(typeof o[k]!=="string"||!o[k])err(`${where}.${k} is required`);else cap(where,k,o[k])});
  (ed.P||[]).forEach((p,i)=>{const w=`P[${i}]`;
    if(!p||typeof p!=="object"){err(w+" not an object");return}
    if(p.type==="article"){need(w,p,["tag","big","kicker","h","p"]);cap(w,"s",p.s);cap(w,"src",p.src);if(!CAT_ART.includes(p.art))err(w+".art invalid")}
    else if(p.type==="list"){need(w,p,["tag","title"]);if(!Array.isArray(p.items)||p.items.length<1||p.items.length>5)err(w+".items needs 1 to 5");else p.items.forEach((it,j)=>{need(`${w}.items[${j}]`,it,["h","d"]);if(!PRI.includes(it.pr))err(`${w}.items[${j}].pr invalid`)})}
    else if(p.type==="grid"){need(w,p,["tag","title"]);if(!Array.isArray(p.tiles)||p.tiles.length<1||p.tiles.length>5)err(w+".tiles needs 1 to 5");else p.tiles.forEach((t,j)=>{need(`${w}.tiles[${j}]`,t,["k","t","d"]);if(!TILES.includes(t.c))err(`${w}.tiles[${j}].c invalid`)})}
    else err(`${w}.type must be article, list or grid`)});
  // a story without a source URL renders as plain text (no link, no search fallback); count them
  let nolink=0;(ed.P||[]).forEach(p=>{if(!p)return;if(p.type==="article"&&!p.u)nolink++;(p.items||[]).forEach(i=>{if(!i.u)nolink++});(p.tiles||[]).forEach(t=>{if(!t.u)nolink++})});
  if(nolink)warn(nolink+" stories have no source URL and will show without a link");
  // privacy + tracking scan over every string value and every url
  (function walk(v,path){
    if(typeof v==="string"){
      if(EMAIL.test(v))err(`${path} contains an email address`);
      if(BAD_WORDS.test(v))err(`${path} contains subscription or referral text`);
      if(/^https?:\/\//i.test(v)){
        let x;try{x=new URL(v)}catch(_){err(`${path} bad url`);return}
        if(x.protocol!=="https:")err(`${path} url must be https`);
        const why=urlProblem(x);if(why)err(`${path} ${why}`);
        for(const k of x.searchParams.keys())if(TRACK_PARAM.test(k))err(`${path} tracking param ${k}`);
      }
    }else if(Array.isArray(v))v.forEach((x,i)=>walk(x,`${path}[${i}]`));
    else if(v&&typeof v==="object")Object.keys(v).forEach(k=>walk(v[k],`${path}.${k}`));
  })(ed,"edition");
  return {ok:errors.length===0,errors,warnings};
}
module.exports={sanitize,lint,cleanUrl,urlProblem,storiesIn,computeCounts};
