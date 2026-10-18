#!/usr/bin/env node
// Regenerates www/data/editions.json (the offline seed bundled in the app) from the feed.
// Newest first. Fields: date, P, TOP, hash, counts. Run after any change to feed/.
const fs=require('fs'),path=require('path');
const {computeCounts}=require('./lib/edition');
const root=path.join(__dirname,'..');
const feed=process.env.FEED_DIR||path.join(root,'feed');
const out=process.env.SEED_OUT||path.join(root,'www','data','editions.json');
const index=JSON.parse(fs.readFileSync(path.join(feed,'index.json'),'utf8'));
const days=index.editions.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(e=>{
  const d=JSON.parse(fs.readFileSync(path.join(feed,e.file),'utf8'));
  return {date:d.date,P:d.P,TOP:d.TOP,hash:e.hash,counts:d.counts||computeCounts(d.P).counts};
});
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify(days));
console.log(`Wrote ${days.length} days to ${path.relative(root,out)||out}`);
