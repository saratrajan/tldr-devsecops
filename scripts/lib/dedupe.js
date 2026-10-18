// Near-duplicate detection between an incoming edition and the feed days just before it.
const THRESHOLD=0.7, WINDOW_DAYS=5, JACCARD=0.6;

function normUrl(u){
  if(!u)return "";
  try{const x=new URL(u);return x.hostname.toLowerCase()+x.pathname.replace(/\/+$/,"")}catch(_){return ""}
}
const wordSet=h=>new Set(String(h||"").toLowerCase().match(/[a-z0-9]+/g)||[]);
function jaccard(a,b){
  if(!a.size||!b.size)return 0;
  let inter=0;for(const w of a)if(b.has(w))inter++;
  return inter/(a.size+b.size-inter);
}
// One entry per article, list item and grid tile.
function stories(ed){
  const out=[],add=(h,u)=>out.push({url:normUrl(u),words:wordSet(h)});
  (ed.P||[]).forEach(p=>{
    if(p.type==="article")add(p.h,p.u);
    else if(p.type==="list")(p.items||[]).forEach(i=>add(i.h,i.u));
    else if(p.type==="grid")(p.tiles||[]).forEach(t=>add(t.t,t.u));
  });
  return out;
}
const same=(a,b)=>(a.url&&a.url===b.url)||jaccard(a.words,b.words)>=JACCARD;
const dayNum=d=>Math.round(Date.parse(d+"T00:00:00Z")/864e5);

// prevDays: parsed day files. Only days 1..5 days BEFORE the incoming date are compared;
// the same date is never compared, so re-publishing a day still replaces it.
function check(incoming,prevDays){
  const inc=stories(incoming),n=dayNum(incoming.date);
  const window=prevDays.filter(d=>{const k=n-dayNum(d.date);return k>=1&&k<=WINDOW_DAYS})
    .sort((a,b)=>b.date.localeCompare(a.date)).map(d=>({date:d.date,st:stories(d)}));
  if(!inc.length)return {duplicate:false,pct:0,dates:[],matched:0,total:0};
  const dates=new Set();let matched=0;
  inc.forEach(s=>{
    for(const d of window){if(d.st.some(t=>same(s,t))){matched++;dates.add(d.date);return}}
  });
  const frac=matched/inc.length;
  return {duplicate:frac>=THRESHOLD,pct:Math.round(frac*100),dates:[...dates].sort(),matched,total:inc.length};
}
module.exports={check,stories,normUrl,jaccard,THRESHOLD,WINDOW_DAYS,JACCARD};
