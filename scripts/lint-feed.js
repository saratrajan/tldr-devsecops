#!/usr/bin/env node
// Lints every file in feed/ and checks index.json matches the day files. Run before every push.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {lint,computeCounts}=require('./lib/edition');
const feed=process.env.FEED_DIR||path.join(__dirname,'..','feed'),dir=path.join(feed,'days');
let bad=0;
const days=fs.readdirSync(dir).filter(f=>/\.json$/.test(f));
for(const f of days){
  let ed;try{ed=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))}catch(e){console.error(f+': invalid JSON');bad++;continue}
  if(f!==ed.date+'.json'){console.error(f+': filename does not match date');bad++}
  const r=lint(ed);r.errors.forEach(e=>{console.error(f+': '+e);bad++});
}
let idx;try{idx=JSON.parse(fs.readFileSync(path.join(feed,'index.json'),'utf8'))}catch(e){console.error('index.json missing or invalid');process.exit(1)}
if(idx.version!==1){console.error('index.json: version must be 1');bad++}
const listed=(idx.editions||[]).map(e=>e.date).sort().join(),have=days.map(f=>f.replace('.json','')).sort().join();
if(listed!==have){console.error('index.json does not match feed/days. Run publish-feed.js or rebuild the index.');bad++}
(idx.editions||[]).forEach(e=>{try{const day=JSON.parse(fs.readFileSync(path.join(feed,e.file),'utf8'));const c=computeCounts(day.P);if(e.total!==c.total||!e.counts||Object.keys(c.counts).some(k=>e.counts[k]!==c.counts[k])){console.error('index counts do not match the pages for '+e.date);bad++}}catch(_){}
  try{const h=crypto.createHash('sha1').update(fs.readFileSync(path.join(feed,e.file))).digest('hex').slice(0,12);if(h!==e.hash){console.error('index hash stale for '+e.date);bad++}}catch(_){} if(!/^days\/\d{4}-\d{2}-\d{2}\.json$/.test(e.file))console.error('bad index file path '+e.file),bad++});
console.log(bad?`LINT FAIL: ${bad} problem(s)`:`LINT OK: ${days.length} days, index consistent`);
process.exit(bad?1:0);
