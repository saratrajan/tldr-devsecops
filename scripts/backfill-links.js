#!/usr/bin/env node
// One-off repair: restores TLDR short links (https://links.tldrnewsletter.com/<code>) that an earlier,
// stricter sanitizer blanked in feed/days. The originals still exist in the first commit that added
// www/data/editions.json. Nothing is fetched from the network: links are copied from git history as-is.
//
// Usage: node scripts/backfill-links.js            dry run (default): prints what would change
//        node scripts/backfill-links.js --apply    writes the days through publish-feed.js, rebuilds the
//                                                  index and www/data/editions.json
// Options: --commit <hash>   use this commit instead of the first one that added the file
// Env:     FEED_DIR overrides the feed folder (tests).
const fs=require('fs'),os=require('os'),path=require('path');
const {spawnSync}=require('child_process');
const root=path.join(__dirname,'..');
const feed=process.env.FEED_DIR||path.join(root,'feed');
const apply=process.argv.includes('--apply');
const ci=process.argv.indexOf('--commit');
const SHORT=/^https?:\/\/links\.tldrnewsletter\.com\/[A-Za-z0-9]{4,12}$/;

function git(...a){const r=spawnSync('git',a,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});if(r.status!==0)throw new Error('git '+a.join(' ')+': '+(r.stderr||'').trim());return r.stdout}
const commit=ci>-1?process.argv[ci+1]:git('log','--diff-filter=A','--format=%h','--','www/data/editions.json').trim().split('\n').pop();
if(!commit){console.error('Could not find a commit that added www/data/editions.json');process.exit(1)}
const old=JSON.parse(git('show',`${commit}:www/data/editions.json`));
const oldByDate=new Map(old.map(e=>[e.date,e]));

// field slots of a page: [label, getter, setter]
function slots(p,i){
  if(!p)return [];
  if(p.type==='article')return [['u',p,'u'],['u2',p,'u2']].map(([n,o,k])=>({where:`page ${i+1} article.${n}`,o,k}));
  if(p.type==='list')return (p.items||[]).map((it,j)=>({where:`page ${i+1} item ${j+1}`,o:it,k:'u'}));
  if(p.type==='grid')return (p.tiles||[]).map((t,j)=>({where:`page ${i+1} tile ${j+1}`,o:t,k:'u'}));
  return [];
}
const files=fs.readdirSync(path.join(feed,'days')).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const report=[],changed=[],sample=[];
const reasons={noOldDay:0,pageMismatch:0,oldEmpty:0,oldNotShortLink:0};
let restored=0,stillEmpty=0;
for(const f of files){
  const day=JSON.parse(fs.readFileSync(path.join(feed,'days',f),'utf8'));
  const od=oldByDate.get(day.date);
  let r=0,e=0;
  day.P.forEach((p,i)=>{
    const op=od&&od.P&&od.P[i];
    const oslots=op&&op.type===p.type?slots(op,i):null;
    slots(p,i).forEach((s,idx)=>{
      if(s.o[s.k])return;                                    // already has a link
      // a field that does not exist (an article without a second link) is not a missing link
      if(s.k==='u2'&&!(op&&op.u2)){return}
      if(!od){reasons.noOldDay++;e++;return}
      if(!oslots){reasons.pageMismatch++;e++;return}
      const was=oslots[idx]&&oslots[idx].o[oslots[idx].k];
      if(!was){reasons.oldEmpty++;e++;return}
      if(!SHORT.test(was)){reasons.oldNotShortLink++;e++;return}
      s.o[s.k]=was.replace(/^http:/,'https:');r++;
      if(sample.length<8)sample.push(`${day.date} ${s.where}: ${s.o[s.k]}  (${(s.o.h||s.o.t||day.P[i].h||'').slice(0,50)})`);
    });
  });
  restored+=r;stillEmpty+=e;
  report.push({date:day.date,restored:r,stillEmpty:e});
  if(r)changed.push({day});
}
console.log(`Source: commit ${commit} (${old.length} days)`);
console.log('date        restored  still empty');
report.forEach(x=>console.log(`${x.date}  ${String(x.restored).padStart(8)}  ${String(x.stillEmpty).padStart(11)}`));
console.log(`\nTotal: ${restored} links restored, ${stillEmpty} fields stay empty.`);
console.log('Why fields stay empty:',JSON.stringify(reasons));
if(sample.length){console.log('\nSample:');sample.forEach(s=>console.log('  '+s))}

if(!apply){console.log('\nDRY RUN. Nothing written. Re-run with --apply to write.');process.exit(0)}

// --apply: write each changed day through publish-feed.js (sanitize, lint, re-hash, rebuild the index)
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tldr-backfill-'));
for(const {day} of changed){
  const f=path.join(tmp,day.date+'.json');fs.writeFileSync(f,JSON.stringify(day));
  const r=spawnSync('node',[path.join(__dirname,'publish-feed.js'),f],{env:{...process.env,FORCE_PUBLISH:'1'},encoding:'utf8'});
  if(r.status!==0){console.error(`FAILED ${day.date}:\n${r.stdout}${r.stderr}`);process.exit(1)}
}
const seed=spawnSync('node',[path.join(__dirname,'build-seed.js')],{env:process.env,encoding:'utf8'});
process.stdout.write(seed.stdout);if(seed.status!==0){console.error(seed.stderr);process.exit(1)}
console.log(`\nApplied. ${changed.length} days rewritten, index and www/data/editions.json rebuilt.`);
