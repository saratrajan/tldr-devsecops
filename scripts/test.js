#!/usr/bin/env node
// Tests for the feed scripts. Run: npm test. Uses temp folders only; never touches the real feed.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
const {spawnSync}=require('child_process');
const root=path.join(__dirname,'..');
const {cleanUrl,lint,sanitize,computeCounts}=require('./lib/edition');
let passed=0,failed=0;
const t=(name,fn)=>{try{fn();passed++;console.log('ok   '+name)}catch(e){failed++;console.log('FAIL '+name+'\n     '+(e.message||e).split('\n')[0])}};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'tldr-test-'));

// ---- helpers: synthetic editions so tests do not depend on real feed content
const story=(n,over={})=>({h:`Story ${n} about topic${n} alpha${n} beta${n} gamma${n}`,d:`Description ${n}`,u:`https://example.com/a${n}`,...over});
function mk(date,stories,tag='TLDR InfoSec'){
  const pages=[];for(let i=0;i<stories.length;i+=4)pages.push({type:'list',tag,title:'T'+i,items:stories.slice(i,i+4).map(s=>({pr:'high',h:s.h,d:s.d,u:s.u}))});
  return {date,source:'gmail',TOP:[[stories[0].h,1]],P:pages};
}
function publish(feedDir,ed,env={}){
  const f=path.join(feedDir,'..','ed-'+ed.date+'.json');fs.writeFileSync(f,JSON.stringify(ed));
  return spawnSync('node',[path.join(__dirname,'publish-feed.js'),f],{env:{...process.env,FEED_DIR:feedDir,...env},encoding:'utf8'});
}
const newFeed=()=>{const d=path.join(tmp(),'feed');fs.mkdirSync(path.join(d,'days'),{recursive:true});return d};
const readDay=(feed,date)=>JSON.parse(fs.readFileSync(path.join(feed,'days',date+'.json'),'utf8'));
const readIndex=feed=>JSON.parse(fs.readFileSync(path.join(feed,'index.json'),'utf8'));
const lintFeed=feed=>spawnSync('node',[path.join(__dirname,'lint-feed.js')],{env:{...process.env,FEED_DIR:feed},encoding:'utf8'});

// ---- Task 1: duplicate detection
{
  const base=[1,2,3,4,5,6,7,8,9,10].map(n=>story(n));
  const feed=newFeed();
  t('publish: a new day is written (exit 0)',()=>{const r=publish(feed,mk('2026-10-10',base));assert.strictEqual(r.status,0,r.stdout+r.stderr);assert.ok(fs.existsSync(path.join(feed,'days','2026-10-10.json')))});
  t('dedupe: same-date re-run replaces the day, not flagged',()=>{const r=publish(feed,mk('2026-10-10',base));assert.strictEqual(r.status,0,r.stdout+r.stderr)});
  t('dedupe: reworded headlines with the same URLs are flagged (exit 3, nothing written)',()=>{
    const re=base.map((s,i)=>({...s,h:`Completely different wording number ${i} here`}));
    const r=publish(feed,mk('2026-10-12',re));assert.strictEqual(r.status,3,r.stdout+r.stderr);
    assert.ok(/DUPLICATE: 100% of stories already published in 2026-10-10\. Nothing written\./.test(r.stdout),r.stdout);
    assert.ok(!fs.existsSync(path.join(feed,'days','2026-10-12.json')))});
  t('dedupe: 50 percent overlap is published',()=>{
    const half=[...base.slice(0,5),...[21,22,23,24,25].map(n=>story(n))];
    const r=publish(feed,mk('2026-10-13',half));assert.strictEqual(r.status,0,r.stdout+r.stderr)});
  t('dedupe: a fully new edition is published',()=>{const r=publish(feed,mk('2026-10-14',[31,32,33,34,35,36,37,38].map(n=>story(n))));assert.strictEqual(r.status,0,r.stdout+r.stderr)});
  t('dedupe: FORCE_PUBLISH=1 bypasses the check',()=>{
    const r=publish(feed,mk('2026-10-15',[31,32,33,34,35,36,37,38].map(n=>story(n))),{FORCE_PUBLISH:'1'});assert.strictEqual(r.status,0,r.stdout+r.stderr)});
  t('dedupe: days older than 5 days are not compared',()=>{
    const f=newFeed();publish(f,mk('2026-10-01',base));
    const r=publish(f,mk('2026-10-20',base));assert.strictEqual(r.status,0,r.stdout+r.stderr)});
  t('lint failure still wins over the duplicate check (exit 1)',()=>{
    const bad=mk('2026-10-16',[story(1,{d:'mail me at a@b.com'})]);const r=publish(feed,bad);assert.strictEqual(r.status,1,r.stdout+r.stderr)});
}

// ---- Task 2: counts
{
  const feed=newFeed();
  const ed=mk('2026-10-10',[1,2,3,4,5].map(n=>story(n)),'TLDR InfoSec');
  ed.P.push({type:'list',tag:'TLDR IT',title:'IT',items:[story(6),story(7)].map(s=>({pr:'watch',h:s.h,d:s.d,u:s.u}))});
  ed.counts={tldr:99,it:99,devops:99,infosec:99};ed.total=1;   // bogus incoming counts must be ignored
  t('counts: incoming counts are ignored and recomputed',()=>{
    const r=publish(feed,ed);assert.strictEqual(r.status,0,r.stdout+r.stderr);
    const d=readDay(feed,'2026-10-10');assert.deepStrictEqual(d.counts,{tldr:0,it:2,devops:0,infosec:5});assert.strictEqual(d.total,7)});
  t('counts: index entry carries counts and total',()=>{const e=readIndex(feed).editions[0];assert.deepStrictEqual(e.counts,{tldr:0,it:2,devops:0,infosec:5});assert.strictEqual(e.total,7)});
  t('counts: lint rejects counts that do not match the pages',()=>{const d=readDay(feed,'2026-10-10');d.counts.it=5;assert.ok(lint(d).errors.some(e=>/do not match/.test(e)))});
  t('counts: lint rejects out-of-range counts',()=>{const d=readDay(feed,'2026-10-10');d.counts.it=61;assert.ok(lint(d).errors.some(e=>/counts\.it/.test(e)))});
  t('counts: old days without counts still lint and get derived index counts',()=>{
    const f=newFeed();const old=sanitize(mk('2026-10-09',[1,2,3].map(n=>story(n))));delete old.counts;delete old.total;
    fs.writeFileSync(path.join(f,'days','2026-10-09.json'),JSON.stringify(old)+'\n');
    assert.ok(lint(old).ok);
    const r=publish(f,mk('2026-10-20',[41,42,43].map(n=>story(n))));assert.strictEqual(r.status,0,r.stdout+r.stderr);
    const e=readIndex(f).editions.find(x=>x.date==='2026-10-09');assert.strictEqual(e.total,3);assert.strictEqual(e.counts.infosec,3);
    const l=lintFeed(f);assert.strictEqual(l.status,0,l.stdout+l.stderr)});
  t('counts: lint-feed catches an index entry that disagrees with its day',()=>{
    const i=readIndex(feed);i.editions[0].total=3;fs.writeFileSync(path.join(feed,'index.json'),JSON.stringify(i));
    assert.strictEqual(lintFeed(feed).status,1)});
  t('counts: category rule (Security..., TLDR InfoSec, TLDR IT, TLDR DevOps, other)',()=>{
    const P=[{type:'list',tag:'Security · x',items:[{},{}]},{type:'list',tag:'TLDR DevOps · y',items:[{}]},{type:'list',tag:'TLDR · Big tech',items:[{}]},{type:'article',tag:'TLDR IT'}];
    assert.deepStrictEqual(computeCounts(P),{counts:{tldr:1,it:1,devops:1,infosec:2},total:5})});
}

// ---- Task 3B: link policy
{
  const short='https://links.tldrnewsletter.com/N3Zxs9';
  t('links: a TLDR short link is kept exactly',()=>assert.strictEqual(cleanUrl(short),short));
  t('links: http short link is upgraded to https',()=>assert.strictEqual(cleanUrl('http://links.tldrnewsletter.com/N3Zxs9'),short));
  t('links: a.tldrnewsletter.com web-version is blanked',()=>assert.strictEqual(cleanUrl('https://a.tldrnewsletter.com/web-version?ep=1&s=abc'),''));
  t('links: unsubscribe URL is blanked',()=>assert.strictEqual(cleanUrl('https://a.tldrnewsletter.com/unsubscribe?ep=1&l=x'),''));
  t('links: refer.tldr.tech is blanked',()=>assert.strictEqual(cleanUrl('https://refer.tldr.tech/00751731/8'),''));
  t('links: short link with a query string is blanked',()=>assert.strictEqual(cleanUrl(short+'?utm_source=x'),''));
  t('links: short link with a bad path is blanked',()=>{assert.strictEqual(cleanUrl('https://links.tldrnewsletter.com/a/b'),'');assert.strictEqual(cleanUrl('https://links.tldrnewsletter.com/ab'),'')});
  t('links: normal URLs lose utm params only',()=>assert.strictEqual(cleanUrl('http://example.com/s?id=7&utm_source=tldr'),'https://example.com/s?id=7'));
  const lintLink=u=>lint(sanitizeKeep(u));
  function sanitizeKeep(u){const d=sanitize(mk('2026-10-10',[story(1)]));d.P[0].items[0].u=u;return d}   // bypass sanitize on purpose
  t('lint: accepts a short link',()=>assert.ok(lintLink(short).ok));
  t('lint: rejects a.tldrnewsletter.com, refer.tldr.tech and a short link with a query',()=>{
    for(const u of ['https://a.tldrnewsletter.com/web-version?x=1','https://refer.tldr.tech/1/2',short+'?a=b'])assert.ok(lintLink(u).errors.length>0,u)});
}

// ---- routine-publish.sh against a local bare git remote (no network)
{
  const git=(cwd,...a)=>spawnSync('git',a,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}});
  const base=tmp(),origin=path.join(base,'origin.git'),work=path.join(base,'work');
  git(base,'init','-q','--bare','-b','main',origin);git(base,'clone','-q',origin,work);
  fs.cpSync(path.join(root,'scripts'),path.join(work,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(work,'www','js'),{recursive:true});fs.copyFileSync(path.join(root,'www','js','shared.js'),path.join(work,'www','js','shared.js'));
  fs.mkdirSync(path.join(work,'feed','days'),{recursive:true});
  git(work,'checkout','-q','-b','main');
  const seed=[1,2,3,4,5,6].map(n=>story(n));
  fs.writeFileSync(path.join(base,'seed.json'),JSON.stringify(mk('2026-10-10',seed)));
  spawnSync('node',[path.join(work,'scripts','publish-feed.js'),path.join(base,'seed.json')],{cwd:work,env:{...process.env,FEED_DIR:path.join(work,'feed')}});
  git(work,'add','-A');git(work,'commit','-q','-m','seed');git(work,'push','-q','-u','origin','main');
  const routine=ed=>{const f=path.join(base,'e.json');fs.writeFileSync(f,JSON.stringify(ed));return spawnSync('bash',[path.join(work,'scripts','routine-publish.sh'),f],{cwd:work,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}})};
  const head=()=>git(origin,'rev-parse','main').stdout.trim();
  t('routine: a new day is committed and pushed',()=>{const before=head();const r=routine(mk('2026-10-12',[11,12,13,14,15,16].map(n=>story(n))));assert.strictEqual(r.status,0,r.stdout+r.stderr);assert.notStrictEqual(head(),before)});
  t('routine: a near-duplicate is skipped with exit 0 and no new commit',()=>{const before=head();const r=routine(mk('2026-10-13',[11,12,13,14,15,16].map(n=>story(n))));assert.strictEqual(r.status,0,r.stdout+r.stderr);assert.ok(/skipped duplicate/.test(r.stdout),r.stdout);assert.strictEqual(head(),before)});
  t('routine: an unchanged re-run is a no-op (no new commit)',()=>{const before=head();const r=routine(mk('2026-10-12',[11,12,13,14,15,16].map(n=>story(n))));assert.strictEqual(r.status,0,r.stdout+r.stderr);assert.strictEqual(head(),before)});
  t('routine: a lint failure exits 1 and pushes nothing',()=>{const before=head();const r=routine(mk('2026-10-14',[story(51,{d:'ping x@y.com'})]));assert.strictEqual(r.status,1,r.stdout+r.stderr);assert.strictEqual(head(),before)});
}

// ---- routine-publish.sh result marker (published | unchanged | duplicate | failed)
{
  const git=(cwd,...a)=>spawnSync('git',a,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}});
  const base=tmp(),origin=path.join(base,'origin.git'),work=path.join(base,'work'),marker=path.join(base,'result');
  git(base,'init','-q','--bare','-b','main',origin);git(base,'clone','-q',origin,work);
  fs.cpSync(path.join(root,'scripts'),path.join(work,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(work,'www','js'),{recursive:true});fs.copyFileSync(path.join(root,'www','js','shared.js'),path.join(work,'www','js','shared.js'));
  fs.mkdirSync(path.join(work,'feed','days'),{recursive:true});git(work,'checkout','-q','-b','main');
  fs.writeFileSync(path.join(base,'seed.json'),JSON.stringify(mk('2026-10-10',[1,2,3,4,5,6].map(n=>story(n)))));
  spawnSync('node',[path.join(work,'scripts','publish-feed.js'),path.join(base,'seed.json')],{cwd:work,env:{...process.env,FEED_DIR:path.join(work,'feed')}});
  git(work,'add','-A');git(work,'commit','-q','-m','seed');git(work,'push','-q','-u','origin','main');
  const run=ed=>{try{fs.unlinkSync(marker)}catch(_){}const f=path.join(base,'e.json');fs.writeFileSync(f,JSON.stringify(ed));
    const r=spawnSync('bash',[path.join(work,'scripts','routine-publish.sh'),f],{cwd:work,encoding:'utf8',env:{...process.env,FEED_RESULT_FILE:marker,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}});
    return {r,out:fs.existsSync(marker)?fs.readFileSync(marker,'utf8').trim():'(none)'}};
  const fresh=[61,62,63,64,65,66].map(n=>story(n));
  t('marker: a new day writes "published"',()=>{const x=run(mk('2026-10-16',fresh));assert.strictEqual(x.r.status,0,x.r.stdout+x.r.stderr);assert.strictEqual(x.out,'published')});
  t('marker: a near-duplicate writes "duplicate"',()=>{const x=run(mk('2026-10-17',fresh));assert.strictEqual(x.r.status,0,x.r.stdout+x.r.stderr);assert.strictEqual(x.out,'duplicate')});
  t('marker: an identical re-run writes "unchanged"',()=>{const x=run(mk('2026-10-16',fresh));assert.strictEqual(x.r.status,0,x.r.stdout+x.r.stderr);assert.strictEqual(x.out,'unchanged')});
  t('marker: a lint failure writes "failed" and exits 1',()=>{const x=run(mk('2026-10-18',[story(71,{d:'mail me at x@y.com'})]));assert.strictEqual(x.r.status,1);assert.strictEqual(x.out,'failed')});
}

// ---- podcast: script lint, meta lint, and publish-podcast.sh with a fast fake synthesizer (no Kokoro needed)
{
  const good=fs.readFileSync(path.join(root,'reference','podcast-example-script.txt'),'utf8');
  const {lintScript,lintMeta}=require('./lib/podcast');
  t('podcast script: the example script passes lint',()=>{const r=lintScript(good);assert.ok(r.ok,r.errors.join('; '));assert.ok(r.stats.words>=850&&r.stats.words<=1100,String(r.stats.words))});
  const errs=(text)=>lintScript(text).errors.join(' | ');
  t('podcast script: a line without a host tag is rejected',()=>assert.ok(/must start with/.test(errs(good+'\nJust some text\n'))));
  t('podcast script: too short is rejected',()=>assert.ok(/too short/.test(errs(good.split('\n').slice(0,20).join('\n')))));
  t('podcast script: too long is rejected',()=>assert.ok(/too long/.test(errs(good+'\n'+good))));
  t('podcast script: first line must be HOST_A',()=>assert.ok(/first line must be HOST_A/.test(errs(good.replace(/^HOST_A:/,'HOST_B:')))));
  t('podcast script: URL, email, CVE id and long number are rejected',()=>{
    for(const [bad,re] of [['See https://example.com now.',/URL/],['Mail a@b.com now.',/email/],['It is CVE-2026-76519 today.',/CVE/],['Total was 12345678 here.',/long number/]])
      assert.ok(re.test(errs(good+'\nHOST_A: '+bad+'\n')),bad)});
  t('podcast script: markup characters and emoji are rejected',()=>{assert.ok(/markup/.test(errs(good+'\nHOST_A: This is **bold** text.\n')));assert.ok(/emoji/.test(errs(good+'\nHOST_A: Great news \u{1F680} today.\n')))});
  t('podcast script: more than 3 turns in a row by one host is rejected',()=>assert.ok(/in a row/.test(errs(good+'\nHOST_A: One.\nHOST_A: Two.\nHOST_A: Three.\nHOST_A: Four.\n'))));
  t('podcast script: a very long single turn is rejected',()=>assert.ok(/words in one turn/.test(errs(good+'\nHOST_B: '+'word '.repeat(95)+'\n'))));

  t('podcast meta: analyzer data is validated when present and optional when absent',()=>{
    const segs=Array.from({length:20},(_,i)=>({h:i%2?'B':'A',t:'Line '+i,s:i*10}));
    const frames=3000,good=Buffer.alloc(frames*16,7).toString('base64');     // 300 s x 10 fps x 16 bands
    const base={version:1,date:'2026-10-19',title:'TL;DR Daily',hosts:{A:'Alice',B:'Michael'},file:'latest.mp3',seconds:300,bytes:2400000,bitrate:128000,hash:'a'.repeat(12),words:900,segments:segs};
    assert.ok(lintMeta(base).ok,'optional when absent');
    assert.ok(lintMeta({...base,specBands:16,specFps:10,spec:good}).ok,lintMeta({...base,specBands:16,specFps:10,spec:good}).errors.join('; '));
    const bad=o=>lintMeta({...base,specBands:16,specFps:10,spec:good,...o}).errors.join(' | ');
    assert.ok(/specBands/.test(bad({specBands:12})));assert.ok(/specFps/.test(bad({specFps:20})));
    assert.ok(/base64/.test(bad({spec:'not base64!!'})));
    assert.ok(/spec has/.test(bad({spec:Buffer.alloc(1600,1).toString('base64')})),'wrong length is rejected');
    assert.ok(/specBands|specFps|spec must/.test(lintMeta({...base,spec:good}).errors.join(' | ')),'spec without bands and fps is rejected');
  });
  { const py=spawnSync('python3',[path.join(__dirname,'podcast','test_spectrum.py')],{encoding:'utf8'});
    if(py.error||py.status===77)console.log('skip spectrum tests: python3 with numpy is not available');
    else t('podcast: the spectrum is computed from real audio (tone lands in its band, silence stays dark)',()=>assert.strictEqual(py.status,0,py.stdout+py.stderr)); }
  { const py=spawnSync('python3',[path.join(__dirname,'podcast','test_plan.py')],{encoding:'utf8'});
    t('podcast: pacing, pauses, overlap and voice blending are planned as designed',()=>assert.strictEqual(py.status,0,py.stdout+py.stderr)); }
  { const py=spawnSync('python3',[path.join(__dirname,'podcast','synth.py'),'--engine','google','--voice-a','en-US-Studio-O','--script',path.join(root,'reference','podcast-example-script.txt'),'--out',path.join(os.tmpdir(),'tldr-synth-guard'),'--date','2026-10-19'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    t('podcast: the Google engine refuses any voice that is not an allowed Chirp 3 HD voice, before any request is made',()=>{assert.strictEqual(py.status,1,py.stdout+py.stderr);assert.ok(/not an allowed Google voice/.test(py.stderr),py.stderr)}); }
  t('podcast script: robotic fillers (hm, mm, uh, um, huh, yeah) are rejected, real reactions are fine',()=>{
    for(const bad of ["Hm, that's the part to watch.","Hmm, right.","Mm, okay.","Mmm.","Uh, so.","Um, well.","Huh, that's odd.","Yeah, that matters.","Mhm.","Hhmm, true."])
      assert.ok(/filler/.test(errs(good+'\nHOST_A: '+bad+'\n')),bad);
    for(const okay of ["Exactly, that's the part to watch.","Absolutely.","Yes, because it matters."])
      assert.ok(!/filler/.test(errs(good+'\nHOST_A: '+okay+'\n')),okay)});
  t('podcast script: both hosts must sign off with their own name',()=>{
    const body=good.trim().split('\n').slice(0,-2),withEnd=(a,b)=>body.concat([a,b]).join('\n');
    const ok=/sign-offs where each host says their own name/;
    assert.ok(!ok.test(errs(withEnd("HOST_B: That's our brief. Thanks for listening. I'm Michael.","HOST_A: And I'm Alice. See you tomorrow."))));
    assert.ok(ok.test(errs(withEnd("HOST_B: That's our brief. Thanks for listening.","HOST_A: I'm Alice. See you tomorrow."))),'only Alice names herself');
    assert.ok(ok.test(errs(withEnd("HOST_B: That's our brief. Thanks for listening. I'm Michael.","HOST_A: See you tomorrow."))),'only Michael names himself');
    assert.ok(!ok.test(errs(withEnd("HOST_B: That's our brief. I\u2019m Michael.","HOST_A: And I\u2019m Alice. See you tomorrow."))),'curly apostrophes');
    assert.ok(!ok.test(errs(withEnd("HOST_A: Thanks for listening. I'm Alice.","HOST_B: And I'm Michael. See you tomorrow."))),'either order');
    assert.ok(ok.test(errs(withEnd("HOST_A: Thanks. I'm Alice.","HOST_B: And I'm Alice."))),'each host must name themself, not the other')});
  const haveFfmpeg=spawnSync('ffmpeg',['-version']).status===0;
  if(!haveFfmpeg){console.log('skip podcast publish tests: ffmpeg not installed')}
  else{
    const base=tmp(),fake=path.join(base,'fake-synth.js'),feed=path.join(base,'feed');
    fs.mkdirSync(feed,{recursive:true});
    // fake synth: a 300 second tone as a real mp3, plus a correct podcast.json built from the script
    fs.writeFileSync(fake,`const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const a=process.argv.slice(2),g=n=>a[a.indexOf(n)+1];const out=g('--out'),date=g('--date');
const turns=fs.readFileSync(g('--script'),'utf8').split(/\\r?\\n/).filter(Boolean).map(l=>({h:l[5],t:l.slice(8).trim()}));
const mp3=path.join(out,'latest.mp3');
const r=spawnSync('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=300','-ac','1','-codec:a','libmp3lame','-b:a','64k',mp3]);if(r.status!==0){console.error('ffmpeg failed');process.exit(1)}
const buf=fs.readFileSync(mp3),step=290/turns.length;
fs.writeFileSync(path.join(out,'podcast.json'),JSON.stringify({version:1,date,title:'TL;DR Daily',hosts:{A:'Alice',B:'Michael'},file:'latest.mp3',seconds:300,bytes:buf.length,bitrate:64000,hash:crypto.createHash('sha1').update(buf).digest('hex').slice(0,12),words:turns.reduce((n,x)=>n+x.t.split(/\\s+/).length,0),segments:turns.map((x,i)=>({h:x.h,t:x.t,s:+(i*step).toFixed(2)}))})+'\\n');`);
    fs.writeFileSync(path.join(base,'script.txt'),good);
    const bare=path.join(base,'origin.git');spawnSync('git',['init','-q','--bare','-b','main',bare]);
    const idx=d=>fs.writeFileSync(path.join(feed,'index.json'),JSON.stringify({version:1,updated:'x',editions:[{date:d,file:'days/'+d+'.json',headline:'h',counts:{tldr:1,it:0,devops:0,infosec:0},total:1,pages:2,hash:'0'.repeat(12)}]}));
    const pub=(date,over={},scriptFile=path.join(base,'script.txt'))=>spawnSync('bash',[path.join(root,'scripts','publish-podcast.sh'),scriptFile,'--date',date],{cwd:root,encoding:'utf8',env:{...process.env,FEED_DIR:feed,PODCAST_SYNTH:'node '+fake,PODCAST_REMOTE:bare,PODCAST_WORK:path.join(base,'work-'+Math.random().toString(36).slice(2)),...over}});
    const gitOut=(...a)=>spawnSync('git',['--git-dir',bare,...a],{encoding:'utf8'}).stdout.trim();
    idx('2026-10-19');
    t('publish-podcast: a good script is built, linted and force-pushed to the podcast branch',()=>{
      const r=pub('2026-10-19');assert.strictEqual(r.status,0,r.stdout+r.stderr);
      assert.strictEqual(gitOut('rev-list','--count','podcast'),'1');
      assert.deepStrictEqual(gitOut('ls-tree','--name-only','podcast').split('\n').sort(),['latest.mp3','podcast.json']);
      const m=JSON.parse(gitOut('show','podcast:podcast.json'));assert.strictEqual(m.date,'2026-10-19');assert.strictEqual(m.segments.length,good.trim().split('\n').length)});
    t('publish-podcast: a second push replaces the branch and keeps a single commit',()=>{
      const before=gitOut('rev-parse','podcast');const r=pub('2026-10-19');assert.strictEqual(r.status,0,r.stdout+r.stderr);
      assert.notStrictEqual(gitOut('rev-parse','podcast'),before);assert.strictEqual(gitOut('rev-list','--count','podcast'),'1')});
    t('publish-podcast: a date that is not the latest edition is refused and nothing is pushed',()=>{
      const before=gitOut('rev-parse','podcast');const r=pub('2026-10-18');assert.strictEqual(r.status,1,r.stdout+r.stderr);
      assert.ok(/not the latest edition/.test(r.stderr),r.stderr);assert.strictEqual(gitOut('rev-parse','podcast'),before)});
    t('publish-podcast: a script that fails lint is refused before any audio is made',()=>{
      const bad=path.join(base,'bad.txt');fs.writeFileSync(bad,good+'\nHOST_A: Mail me at a@b.com now.\n');
      const before=gitOut('rev-parse','podcast');const r=pub('2026-10-19',{},bad);assert.strictEqual(r.status,1);assert.ok(/did not pass lint/.test(r.stderr),r.stderr);assert.strictEqual(gitOut('rev-parse','podcast'),before)});
    t('publish-podcast: an audio file that does not match podcast.json is refused',()=>{
      const bad=path.join(base,'bad-synth.js');fs.writeFileSync(bad,fs.readFileSync(fake,'utf8')+"\nfs.appendFileSync(mp3,Buffer.from('tamper'));");
      const before=gitOut('rev-parse','podcast');const r=pub('2026-10-19',{PODCAST_SYNTH:'node '+bad});assert.strictEqual(r.status,1,r.stdout+r.stderr);assert.ok(/did not pass lint/.test(r.stderr),r.stderr);assert.strictEqual(gitOut('rev-parse','podcast'),before)});
    t('publish-podcast: a synthesizer failure pushes nothing and exits 1',()=>{
      const before=gitOut('rev-parse','podcast');const r=pub('2026-10-19',{PODCAST_SYNTH:'node -e process.exit(2)'});assert.strictEqual(r.status,1);assert.strictEqual(gitOut('rev-parse','podcast'),before)});
    t('publish-podcast: when the server refuses force pushes it replaces the branch by delete and push',()=>{
      const strict=path.join(base,'strict.git');spawnSync('git',['init','-q','--bare','-b','main',strict]);
      spawnSync('git',['--git-dir',strict,'config','receive.denyNonFastForwards','true']);
      const run=()=>pub('2026-10-19',{PODCAST_REMOTE:strict});
      const first=run();assert.strictEqual(first.status,0,first.stdout+first.stderr);
      const sg=(...a)=>spawnSync('git',['--git-dir',strict,...a],{encoding:'utf8'}).stdout.trim();
      const before=sg('rev-parse','podcast');
      const second=run();assert.strictEqual(second.status,0,second.stdout+second.stderr);
      assert.ok(/replacing the branch by delete and push/.test(second.stderr),second.stderr);
      assert.notStrictEqual(sg('rev-parse','podcast'),before);assert.strictEqual(sg('rev-list','--count','podcast'),'1')});
    t('publish-podcast: NO_PUSH builds and lints but does not push',()=>{
      const before=gitOut('rev-parse','podcast');const r=pub('2026-10-19',{NO_PUSH:'1'});assert.strictEqual(r.status,0,r.stdout+r.stderr);assert.strictEqual(gitOut('rev-parse','podcast'),before)});
    t('podcast meta: bad duration, hash, segments, email and URL are each rejected',()=>{
      const segs=Array.from({length:20},(_,i)=>({h:i%2?'B':'A',t:'Line '+i,s:i*10}));
      const ok={version:1,date:'2026-10-19',title:'TL;DR Daily',hosts:{A:'Alice',B:'Michael'},file:'latest.mp3',seconds:300,bytes:2400000,bitrate:128000,hash:'a'.repeat(12),words:900,segments:segs};
      assert.ok(lintMeta(ok).ok,lintMeta(ok).errors.join('; '));
      const bad=(over)=>lintMeta({...ok,...over}).errors.join(' | ');
      assert.ok(/seconds/.test(bad({seconds:100})));assert.ok(/seconds/.test(bad({seconds:900})));
      assert.ok(/hash/.test(bad({hash:'xyz'})));assert.ok(/file must be/.test(bad({file:'other.mp3'})));
      assert.ok(/bytes/.test(bad({bytes:20000000})));assert.ok(/unknown key/.test(bad({extra:1})));
      assert.ok(/non-decreasing/.test(bad({segments:segs.map((x,i)=>i===5?{...x,s:1}:x)})));
      assert.ok(/starts after the audio ends/.test(bad({segments:segs.map((x,i)=>i===19?{...x,s:400}:x)})));
      assert.ok(/email/.test(bad({segments:segs.map((x,i)=>i===3?{...x,t:'mail a@b.com'}:x)})));
      assert.ok(/URL/.test(bad({segments:segs.map((x,i)=>i===3?{...x,t:'see https://x.com'}:x)})));
    });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
