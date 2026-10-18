#!/usr/bin/env node
// Prints, for every feed day, how much of it already appeared in the 5 days before it.
// Use it to judge the duplicate threshold. Read-only.
const {loadDays}=require('./publish-feed');
const {check,THRESHOLD}=require('./lib/dedupe');
const days=loadDays().sort((a,b)=>a.date.localeCompare(b.date));
console.log(`threshold ${Math.round(THRESHOLD*100)}%`);
console.log('date        stories  overlap  verdict    overlaps with');
days.forEach(d=>{
  const r=check(d,days.filter(x=>x.date!==d.date));
  console.log(`${d.date}  ${String(r.total).padStart(7)}  ${String(r.pct+'%').padStart(7)}  ${(r.duplicate?'DUPLICATE':'ok').padEnd(9)}  ${r.dates.join(', ')||'-'}`);
});
