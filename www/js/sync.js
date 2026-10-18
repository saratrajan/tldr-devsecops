/* Feed sync: reads feed/index.json from the public repo, downloads days it does not have,
   validates every payload, and caches them in IndexedDB. Never throws into the UI. */
(function(){
"use strict";
const DB="tldr",ST="days",MAX_BYTES=400000,MAX_DAYS_PER_SYNC=60,TIMEOUT=8000;
const TYPES={article:1,list:1,grid:1};
const open=()=>new Promise((res,rej)=>{if(!window.indexedDB)return rej(new Error("no indexedDB"));const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(ST,{keyPath:"date"});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const all=()=>open().then(db=>new Promise((res,rej)=>{const q=db.transaction(ST).objectStore(ST).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)}));
const put=rec=>open().then(db=>new Promise((res,rej)=>{const t=db.transaction(ST,"readwrite");t.objectStore(ST).put(rec);t.oncomplete=()=>res();t.onerror=()=>rej(t.error)}));
const str=v=>typeof v==="string";
function validDay(d){
 if(!d||d.version!==1||!/^\d{4}-\d{2}-\d{2}$/.test(d.date||""))return false;
 if(!Array.isArray(d.P)||d.P.length<1||d.P.length>12||!Array.isArray(d.TOP)||d.TOP.length<1||d.TOP.length>6)return false;
 if(!d.TOP.every(t=>Array.isArray(t)&&str(t[0])&&Number.isInteger(t[1])&&t[1]>=1&&t[1]<=d.P.length))return false;
 return d.P.every(p=>p&&TYPES[p.type]&&str(p.tag)&&(p.type==="article"?str(p.h)&&str(p.p)&&str(p.big):p.type==="list"?str(p.title)&&Array.isArray(p.items)&&p.items.length<=5&&p.items.every(i=>i&&str(i.h)&&str(i.d)&&str(i.pr)):str(p.title)&&Array.isArray(p.tiles)&&p.tiles.length<=5&&p.tiles.every(t=>t&&str(t.t)&&str(t.d)&&str(t.k)&&str(t.c))));
}
async function getJSON(url){
 const ac=typeof AbortController==="function"?new AbortController():null;
 const timer=setTimeout(()=>ac&&ac.abort(),TIMEOUT);
 try{const r=await fetch(url,{cache:"no-store",signal:ac&&ac.signal});if(!r.ok)throw new Error("HTTP "+r.status);
  const t=await r.text();if(t.length>MAX_BYTES)throw new Error("payload too large");return JSON.parse(t)}
 finally{clearTimeout(timer)}
}
/* have: {date: hash} for editions already on the device. Returns {added:[{date,hash,data}], skipped, listed}. */
async function sync(base,have){
 const idx=await getJSON(base+"index.json?t="+Date.now());
 if(!idx||idx.version!==1||!Array.isArray(idx.editions))throw new Error("unsupported feed version");
 const todo=idx.editions.filter(e=>e&&/^\d{4}-\d{2}-\d{2}$/.test(e.date)&&/^days\/\d{4}-\d{2}-\d{2}\.json$/.test(e.file)&&str(e.hash)&&have[e.date]!==e.hash).slice(0,MAX_DAYS_PER_SYNC);
 const added=[];let skipped=0;
 for(const e of todo){
  try{const day=await getJSON(base+e.file+"?h="+encodeURIComponent(e.hash));
   if(!validDay(day)||day.date!==e.date){skipped++;continue}
   const rec={date:e.date,hash:e.hash,data:day};
   try{await put(rec)}catch(_){}      // cache is best effort
   added.push(rec)}catch(_){skipped++}
 }
 return {added,skipped,listed:idx.editions.length};
}
window.TldrSync={all,validDay,sync};
})();
