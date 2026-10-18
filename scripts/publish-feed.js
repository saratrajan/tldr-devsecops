#!/usr/bin/env node
// Sanitize + lint one edition, then write feed/days/<date>.json and rebuild feed/index.json.
// Usage: node scripts/publish-feed.js edition.json      (or pipe JSON on stdin)
// Exit codes: 0 written, 1 lint or input error (nothing written),
//             3 near-duplicate of a recent day (nothing written; FORCE_PUBLISH=1 bypasses).
// FEED_DIR overrides the feed folder (used by the tests).
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {sanitize,lint,computeCounts}=require('./lib/edition');
const {check}=require('./lib/dedupe');
const feed=process.env.FEED_DIR||path.join(__dirname,'..','feed');
function loadDays(){
  const dir=path.join(feed,'days');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>{try{return JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))}catch(_){return null}}).filter(Boolean);
}
function rebuildIndex(){
  const dir=path.join(feed,'days');
  const eds=fs.readdirSync(dir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>{const raw=fs.readFileSync(path.join(dir,f));const e=JSON.parse(raw);e.hash=crypto.createHash('sha1').update(raw).digest('hex').slice(0,12);return e});
  eds.sort((a,b)=>b.date.localeCompare(a.date));
  const editions=eds.map(e=>{
    const c=e.counts&&e.total!==undefined?{counts:e.counts,total:e.total}:computeCounts(e.P);   // old days: derive from pages
    return {date:e.date,file:'days/'+e.date+'.json',headline:e.TOP[0][0],counts:c.counts,total:c.total,pages:e.P.length+1,hash:e.hash};
  });
  // Keep the old timestamp when nothing changed, so an identical re-run makes no git diff.
  let updated=new Date().toISOString();
  try{const old=JSON.parse(fs.readFileSync(path.join(feed,'index.json'),'utf8'));if(JSON.stringify(old.editions)===JSON.stringify(editions))updated=old.updated}catch(_){}
  const index={version:1,updated,editions};
  fs.writeFileSync(path.join(feed,'index.json'),JSON.stringify(index,null,1)+'\n');
  return index;
}
module.exports={rebuildIndex,loadDays,feed};
if(require.main===module){
  const src=process.argv[2]&&process.argv[2]!=='-'?fs.readFileSync(process.argv[2],'utf8'):fs.readFileSync(0,'utf8');
  let raw;try{raw=JSON.parse(src)}catch(e){console.error('LINT FAIL: invalid JSON: '+e.message);process.exit(1)}
  const ed=sanitize(raw);const r=lint(ed);
  r.warnings.forEach(w=>console.log('warn: '+w));
  if(!r.ok){r.errors.forEach(e=>console.error('error: '+e));console.error('LINT FAIL: nothing written');process.exit(1)}
  const dup=check(ed,loadDays().filter(d=>d.date!==ed.date));
  if(dup.duplicate&&process.env.FORCE_PUBLISH!=='1'){
    console.log(`DUPLICATE: ${dup.pct}% of stories already published in ${dup.dates.join(', ')}. Nothing written.`);
    process.exit(3);
  }
  fs.mkdirSync(path.join(feed,'days'),{recursive:true});
  fs.writeFileSync(path.join(feed,'days',ed.date+'.json'),JSON.stringify(ed)+'\n');
  const idx=rebuildIndex();
  console.log('LINT OK. Wrote feed/days/'+ed.date+'.json. Index has '+idx.editions.length+' editions.');
}
