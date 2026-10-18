// Linting for the two-host podcast script and for the published podcast.json.
const fs=require('fs');
const crypto=require('crypto');
const {spawnSync}=require('child_process');

const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URLISH=/(https?:\/\/|www\.)/i;
const BAD=/unsubscribe|manage your subscription|referral/i;
const LIMITS={minWords:700,maxWords:1200,warnLow:850,warnHigh:1100,minTurns:16,maxTurns:140,maxTurnWords:80,warnTurnWords:60};

function parseScript(text){
  const turns=[],errors=[];
  text.split(/\r?\n/).forEach((raw,i)=>{
    const line=raw.trim();if(!line)return;
    const m=line.match(/^HOST_([AB]):\s*(.+)$/);
    if(!m)errors.push(`line ${i+1}: must start with "HOST_A: " or "HOST_B: "`);
    else turns.push({h:m[1],t:m[2].trim(),line:i+1});
  });
  return {turns,errors};
}
const words=s=>s.split(/\s+/).filter(Boolean).length;

function lintScript(text){
  const {turns,errors}=parseScript(text),warnings=[];
  const err=m=>errors.push(m),warn=m=>warnings.push(m);
  let total=0;
  if(turns.length&&turns[0].h!=='A')err('the first line must be HOST_A (Alice opens the show)');
  let run=0,prev='';
  turns.forEach(t=>{
    const w=words(t.t);total+=w;
    if(w>LIMITS.maxTurnWords)err(`line ${t.line}: ${w} words in one turn (max ${LIMITS.maxTurnWords}); split it into shorter turns`);
    else if(w>LIMITS.warnTurnWords)warn(`line ${t.line}: long turn (${w} words)`);
    run=t.h===prev?run+1:1;prev=t.h;
    if(run>3)err(`line ${t.line}: more than 3 turns in a row by the same host`);
    if(URLISH.test(t.t))err(`line ${t.line}: contains a URL`);
    if(EMAIL.test(t.t))err(`line ${t.line}: contains an email address`);
    if(BAD.test(t.t))err(`line ${t.line}: contains subscription or referral text`);
    if(/[*#`\[\]<>{}|_~]/.test(t.t))err(`line ${t.line}: contains markup characters (* # \` [ ] < > { } | _ ~); write plain sentences`);
    if(/\bCVE-\d{4}-\d+/i.test(t.t))err(`line ${t.line}: a CVE identifier cannot be spoken; say "a critical flaw in X" instead`);
    if(/\d{6,}/.test(t.t.replace(/\d{1,3}(,\d{3})+/g,'')))err(`line ${t.line}: a long number cannot be spoken; write it in words or round it`);
    if(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t.t))err(`line ${t.line}: contains an emoji`);
    if(/\bsponsor/i.test(t.t))warn(`line ${t.line}: mentions a sponsor; sponsor content should not be in the show`);
  });
  if(turns.length<LIMITS.minTurns)err(`only ${turns.length} turns (min ${LIMITS.minTurns})`);
  if(turns.length>LIMITS.maxTurns)err(`${turns.length} turns (max ${LIMITS.maxTurns})`);
  if(total<LIMITS.minWords)err(`${total} words is too short (min ${LIMITS.minWords}, aim for 900 to 1050)`);
  else if(total>LIMITS.maxWords)err(`${total} words is too long (max ${LIMITS.maxWords}, aim for 900 to 1050)`);
  else if(total<LIMITS.warnLow||total>LIMITS.warnHigh)warn(`${total} words; the sweet spot is 900 to 1050`);
  if(turns.length>=2){
    const [x,y]=turns.slice(-2),says=(t,n)=>t.h===(n==='Alice'?'A':'B')&&new RegExp(`\\b(I['\u2019]m|this is|it['\u2019]s) ${n}\\b`,'i').test(t.t);
    if(!((says(x,'Alice')&&says(y,'Michael'))||(says(x,'Michael')&&says(y,'Alice'))))
      err('the last two lines must be sign-offs where each host says their own name, for example HOST_B: "That\'s our brief. Thanks for listening. I\'m Michael." then HOST_A: "And I\'m Alice. See you tomorrow."');
  }
  const all=turns.map(t=>t.t).join(' ');
  if(!/\bAlice\b/.test(all))warn('Alice is never named');
  if(!/\bMichael\b/.test(all))warn('Michael is never named');
  return {ok:errors.length===0,errors,warnings,stats:{turns:turns.length,words:total,minutes:+(total/142).toFixed(1)}};
}

// meta: parsed podcast.json. mp3Path optional: also checks the audio file itself.
function lintMeta(meta,mp3Path){
  const errors=[],warnings=[];
  const err=m=>errors.push(m);
  if(!meta||typeof meta!=='object'){return {ok:false,errors:['podcast.json is not an object'],warnings}}
  const allowed=['version','date','title','hosts','file','seconds','bytes','bitrate','hash','words','segments','specBands','specFps','spec'];
  Object.keys(meta).forEach(k=>{if(!allowed.includes(k))err('unknown key: '+k)});
  if(meta.version!==1)err('version must be 1');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(meta.date||'')||isNaN(Date.parse(meta.date)))err('date must be a real YYYY-MM-DD');
  if(typeof meta.title!=='string'||!meta.title||meta.title.length>80)err('title is required (max 80 characters)');
  if(!meta.hosts||typeof meta.hosts.A!=='string'||typeof meta.hosts.B!=='string'||meta.hosts.A.length>20||meta.hosts.B.length>20)err('hosts needs short names for A and B');
  if(meta.file!=='latest.mp3')err('file must be "latest.mp3"');
  if(!(meta.seconds>=240&&meta.seconds<=600))err(`seconds ${meta.seconds} is outside 240..600 (4 to 10 minutes)`);
  if(!Number.isInteger(meta.bytes)||meta.bytes<300000||meta.bytes>15e6)err(`bytes ${meta.bytes} is outside 300000..15000000`);
  if(!Number.isInteger(meta.bitrate)||meta.bitrate<48000||meta.bitrate>192000)err('bitrate must be 48000..192000');
  if(!/^[0-9a-f]{12}$/.test(meta.hash||''))err('hash must be 12 hex characters');
  if(!Number.isInteger(meta.words)||meta.words<300||meta.words>2000)err('words out of range');
  const segs=meta.segments;
  if(!Array.isArray(segs)||segs.length<LIMITS.minTurns||segs.length>LIMITS.maxTurns)err(`segments needs ${LIMITS.minTurns}..${LIMITS.maxTurns} entries`);
  else{
    let last=-1;
    segs.forEach((s,i)=>{
      if(!s||(s.h!=='A'&&s.h!=='B'))err(`segments[${i}].h must be A or B`);
      if(!s||typeof s.t!=='string'||!s.t||s.t.length>700)err(`segments[${i}].t must be text up to 700 characters`);
      else{if(EMAIL.test(s.t))err(`segments[${i}] contains an email address`);if(URLISH.test(s.t))err(`segments[${i}] contains a URL`)}
      if(!s||typeof s.s!=='number'||s.s<last||s.s<0)err(`segments[${i}].s must be a non-decreasing start time in seconds`);
      else last=s.s;
    });
    if(typeof meta.seconds==='number'&&last>=meta.seconds)err('the last segment starts after the audio ends');
  }
  if(meta.spec!==undefined||meta.specBands!==undefined||meta.specFps!==undefined){     // analyzer data is optional
    if(meta.specBands!==16)err('specBands must be 16');
    if(meta.specFps!==10)err('specFps must be 10');
    if(typeof meta.spec!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(meta.spec))err('spec must be base64');
    else if(meta.specBands===16&&meta.specFps===10&&typeof meta.seconds==='number'){
      const bytes=Buffer.from(meta.spec,'base64').length,frames=bytes/16;
      if(!Number.isInteger(frames)||Math.abs(frames-meta.seconds*10)>30)err(`spec has ${bytes} bytes; expected about ${Math.round(meta.seconds*10*16)} (16 bands, 10 frames per second)`);
    }
  }
  if(mp3Path){
    let buf;try{buf=fs.readFileSync(mp3Path)}catch(e){err('cannot read '+mp3Path);buf=null}
    if(buf){
      if(buf.length!==meta.bytes)err(`mp3 is ${buf.length} bytes but podcast.json says ${meta.bytes}`);
      if(crypto.createHash('sha1').update(buf).digest('hex').slice(0,12)!==meta.hash)err('mp3 hash does not match podcast.json');
      const head=buf.slice(0,3).toString('latin1');
      if(!(head==='ID3'||(buf[0]===0xff&&(buf[1]&0xe0)===0xe0)))err('file does not look like an mp3');
      const p=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_name,channels:format=duration','-of','json',mp3Path],{encoding:'utf8'});
      if(p.error||p.status!==0)warnings.push('ffprobe not available; audio not probed');
      else{
        try{const j=JSON.parse(p.stdout),st=(j.streams||[])[0]||{},d=parseFloat(j.format&&j.format.duration);
          if(st.codec_name!=='mp3')err('audio codec is '+st.codec_name+', expected mp3');
          if(Math.abs(d-meta.seconds)>1.5)err(`audio is ${d.toFixed(1)}s but podcast.json says ${meta.seconds}s`);
        }catch(_){err('could not read ffprobe output')}
      }
    }
  }
  return {ok:errors.length===0,errors,warnings};
}
module.exports={parseScript,lintScript,lintMeta,LIMITS};
