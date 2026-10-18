/* "Listen" for the latest edition only.
   The routine publishes ONE podcast (latest.mp3 + podcast.json) on the repo's "podcast" branch and replaces it daily.
   This module checks podcast.json, downloads the mp3 once, verifies it, keeps a single copy on the device, and plays it
   with a transcript that follows the audio. On Android the media-session plugin runs a foreground service while audio
   plays, so playback keeps going with the screen off and gives lock-screen controls. */
(function(){
"use strict";
const DEFAULT_BASE="https://raw.githubusercontent.com/saratrajan/tldr-devsecops/podcast/";
const DB="tldr-podcast",STORE="audio",KEY="latest",TIMEOUT=8000,MAX_BYTES=30e6,RATES=[1,1.25,1.5];
const $=(s,r=document)=>r.querySelector(s);
const store={get(k){try{return localStorage.getItem(k)}catch(_){return null}}};
const base=()=>(store.get("tldr.podcastBase")||DEFAULT_BASE).replace(/\/?$/,"/");
const fmt=s=>{s=Math.max(0,Math.round(s||0));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")};
const ICON={
 phones:'<svg viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
 play:'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>',
 pause:'<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/></svg>',
 back:'<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/></svg>',
 fwd:'<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/></svg>',
 down:'<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>'
};

/* ---- state ---- */
let meta=null,latestDate=null,cached=null;      // meta: validated podcast.json for the latest edition, or null
let audio=null,objUrl="",ui=null,busy=null,abort=null,msPlugin,lastPos=0,userScrollAt=0,activeIdx=-1;
const S={state:"idle",progress:0,rate:1,open:false,err:""};   // idle | loading | ready | playing | paused | ended | error

/* ---- single cached copy in IndexedDB (own database, so it never clashes with the editions cache) ---- */
const idb=()=>new Promise((res,rej)=>{if(!window.indexedDB)return rej(new Error("no indexedDB"));const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE,{keyPath:"key"});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const idbGet=()=>idb().then(db=>new Promise((res,rej)=>{const q=db.transaction(STORE).objectStore(STORE).get(KEY);q.onsuccess=()=>res(q.result||null);q.onerror=()=>rej(q.error)}));
const idbPut=rec=>idb().then(db=>new Promise((res,rej)=>{const t=db.transaction(STORE,"readwrite");t.objectStore(STORE).put(rec);t.oncomplete=()=>res();t.onerror=()=>rej(t.error)}));

/* ---- validation of remote data ---- */
function validMeta(m){
 if(!m||m.version!==1||!/^\d{4}-\d{2}-\d{2}$/.test(m.date||"")||m.file!=="latest.mp3")return false;
 if(!/^[0-9a-f]{12}$/.test(m.hash||"")||!Number.isInteger(m.bytes)||m.bytes<1||m.bytes>MAX_BYTES)return false;
 if(!(m.seconds>0)||typeof m.title!=="string"||!m.hosts||typeof m.hosts.A!=="string"||typeof m.hosts.B!=="string")return false;
 return Array.isArray(m.segments)&&m.segments.length>0&&m.segments.length<=200&&m.segments.every(s=>s&&(s.h==="A"||s.h==="B")&&typeof s.t==="string"&&typeof s.s==="number"&&s.s>=0);
}
async function getJSON(url){
 const ac=typeof AbortController==="function"?new AbortController():null,t=setTimeout(()=>ac&&ac.abort(),TIMEOUT);
 try{const r=await fetch(url,{cache:"no-store",signal:ac&&ac.signal});if(!r.ok)throw new Error("HTTP "+r.status);const x=await r.text();if(x.length>400000)throw new Error("too large");return JSON.parse(x)}finally{clearTimeout(t)}
}

/* ---- availability: Listen exists only when podcast.json is for the latest edition ---- */
async function refresh(date){
 latestDate=date||latestDate;
 if(!latestDate){meta=null;syncButtons();return null}
 try{cached=await idbGet()}catch(_){cached=null}
 try{
  const m=await getJSON(base()+"podcast.json?t="+Date.now());
  meta=validMeta(m)&&m.date===latestDate?m:null;
 }catch(_){
  meta=cached&&cached.date===latestDate&&validMeta(cached.meta)?cached.meta:null;   // offline: use the saved copy
 }
 syncButtons();updateUI();
 return meta;
}
const available=()=>!!meta;
const hasCopy=()=>!!(cached&&meta&&cached.hash===meta.hash&&cached.blob);

/* ---- buttons that app.js renders (hidden until a podcast exists for that edition) ---- */
function syncButtons(){
 document.querySelectorAll("[data-listen]").forEach(b=>{
  const ok=!!meta&&b.dataset.date===meta.date;b.hidden=!ok;
  const l=b.querySelector("[data-listen-label]");if(l&&meta)l.textContent="Listen · "+Math.max(1,Math.round(meta.seconds/60))+" min";
 });
}

/* ---- download once, verify, keep a single copy ---- */
async function prepare(){
 if(!meta)throw new Error("No podcast for this edition");
 if(hasCopy())return cached.blob;
 S.state="loading";S.progress=0;S.err="";updateUI();
 abort=typeof AbortController==="function"?new AbortController():null;
 const res=await fetch(base()+"latest.mp3?v="+meta.hash,{cache:"no-store",signal:abort&&abort.signal});
 if(!res.ok)throw new Error("Download failed (HTTP "+res.status+")");
 const total=+res.headers.get("content-length")||meta.bytes;
 let blob;
 if(res.body&&res.body.getReader){
  const rd=res.body.getReader(),parts=[];let got=0;
  for(;;){const {done,value}=await rd.read();if(done)break;parts.push(value);got+=value.length;S.progress=Math.min(1,got/total);updateProgressOnly()}
  blob=new Blob(parts,{type:"audio/mpeg"});
 }else blob=new Blob([await res.blob()],{type:"audio/mpeg"});
 if(blob.size!==meta.bytes)throw new Error("The download was incomplete. Try again.");
 if(window.crypto&&crypto.subtle){
  const h=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1",await blob.arrayBuffer()))).map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,12);
  if(h!==meta.hash)throw new Error("The download did not match. Try again.");
 }
 cached={key:KEY,date:meta.date,hash:meta.hash,meta,blob};
 try{await idbPut(cached)}catch(_){}     // best effort; replaces the previous day's file
 return blob;
}

/* ---- media session: Android foreground service via the plugin, or the browser API ---- */
function ms(){
 if(msPlugin!==undefined)return msPlugin;
 msPlugin=null;
 try{const C=window.Capacitor;if(C&&C.isNativePlatform&&C.isNativePlatform())msPlugin=(C.Plugins&&C.Plugins.MediaSession)||(C.registerPlugin&&C.registerPlugin("MediaSession"))||null}catch(_){msPlugin=null}
 return msPlugin;
}
function msCall(name,...a){try{const p=ms();if(p&&p[name])return Promise.resolve(p[name](...a)).catch(()=>{})}catch(_){}}
function msSetup(){
 if(!meta)return;
 const md={title:meta.title,artist:meta.hosts.A+" and "+meta.hosts.B,album:"TL;DR Daily",artwork:[]};
 if(ms()){
  msCall("setMetadata",md);
  const h=(a,fn)=>msCall("setActionHandler",{action:a},fn);
  h("play",()=>play());h("pause",()=>pause());h("seekbackward",()=>skip(-15));h("seekforward",()=>skip(30));
  h("seekto",d=>{if(d&&typeof d.seekTime==="number")seek(d.seekTime)});h("stop",()=>stop());
 }else if("mediaSession"in navigator){
  try{navigator.mediaSession.metadata=new MediaMetadata(md);
   navigator.mediaSession.setActionHandler("play",()=>play());navigator.mediaSession.setActionHandler("pause",()=>pause());
   navigator.mediaSession.setActionHandler("seekbackward",()=>skip(-15));navigator.mediaSession.setActionHandler("seekforward",()=>skip(30));
   navigator.mediaSession.setActionHandler("seekto",d=>{if(d&&typeof d.seekTime==="number")seek(d.seekTime)})}catch(_){}
 }
}
function msState(st){
 if(ms())msCall("setPlaybackState",{playbackState:st});
 else if("mediaSession"in navigator){try{navigator.mediaSession.playbackState=st==="none"?"none":st}catch(_){}}
}
function msPosition(){
 if(!audio||!isFinite(audio.duration))return;
 const o={duration:audio.duration,playbackRate:audio.playbackRate,position:Math.min(audio.currentTime,audio.duration)};
 if(ms())msCall("setPositionState",o);else if("mediaSession"in navigator){try{navigator.mediaSession.setPositionState(o)}catch(_){}}
}

/* ---- audio element ---- */
function ensureAudio(){
 if(audio)return audio;
 audio=new Audio();audio.preload="auto";
 audio.addEventListener("timeupdate",onTime);
 audio.addEventListener("play",()=>{S.state="playing";msState("playing");msPosition();updateUI();visKick()});
 audio.addEventListener("pause",()=>{if(!audio.ended){S.state="paused";msState("paused");msPosition();updateUI()}});
 audio.addEventListener("ended",()=>{S.state="ended";msState("none");updateUI()});
 audio.addEventListener("error",()=>{S.state="error";S.err="This audio could not be played.";msState("none");updateUI()});
 audio.addEventListener("loadedmetadata",updateUI);
 return audio;
}
async function load(){
 const blob=await prepare();
 const a=ensureAudio();
 if(objUrl)URL.revokeObjectURL(objUrl);
 objUrl=URL.createObjectURL(blob);a.src=objUrl;a.playbackRate=S.rate;
 S.state="ready";msSetup();
}
async function start(){          // the Listen button
 openSheet();
 if(S.state==="loading")return;
 try{
  if(!audio||!audio.src||S.state==="idle"||S.state==="error")await load();
  else if(cached&&meta&&cached.hash!==meta.hash){await load()}   // a newer podcast replaced the one that was loaded
  if(S.state==="ended")audio.currentTime=0;
  await play();
 }catch(e){if(e&&e.name==="AbortError"){S.state="idle"}else{S.state="error";S.err=(e&&e.message)||"Could not load the podcast."}updateUI()}
}
async function play(){if(!audio)return;try{await audio.play()}catch(e){S.state="paused";updateUI()}}
function pause(){if(audio)audio.pause()}
function toggle(){if(!audio||S.state==="idle"||S.state==="error"){start();return}audio.paused?play():pause()}
function seek(t){if(!audio)return;const d=audio.duration||(meta&&meta.seconds)||0;audio.currentTime=Math.max(0,Math.min(d,t));msPosition();onTime()}
function skip(d){if(audio)seek(audio.currentTime+d)}
function setRate(r){S.rate=r;if(audio)audio.playbackRate=r;msPosition();updateUI()}
function cycleRate(){setRate(RATES[(RATES.indexOf(S.rate)+1)%RATES.length])}
function stop(){
 if(abort){try{abort.abort()}catch(_){}abort=null}
 if(audio){audio.pause();try{audio.removeAttribute("src");audio.load()}catch(_){}}
 if(objUrl){URL.revokeObjectURL(objUrl);objUrl=""}
 S.state="idle";S.progress=0;activeIdx=-1;msState("none");updateUI();
}

/* ---- 7-segment LCD digits (drawn in SVG, no font needed) ---- */
const NS="http://www.w3.org/2000/svg";
const SEG={0:"abcdef",1:"bc",2:"abdeg",3:"abcdg",4:"bcfg",5:"acdfg",6:"acdefg",7:"abc",8:"abcdefg",9:"abcdfg","-":"g"," ":""};
const SEGDEF={a:[6,1.6,0],g:[6,11,0],d:[6,20.4,0],f:[1.6,6.4,1],b:[10.4,6.4,1],e:[1.6,15.6,1],c:[10.4,15.6,1]};
function hexPts(cx,cy,L,t,vert){
 const pts=[[-L/2,0],[-L/2+t/2,-t/2],[L/2-t/2,-t/2],[L/2,0],[L/2-t/2,t/2],[-L/2+t/2,t/2]];
 return pts.map(([x,y])=>(vert?(cx+y):(cx+x))+","+(vert?(cy+x):(cy+y))).join(" ");
}
function svgEl(name,attrs){const e=document.createElementNS(NS,name);for(const k in attrs)e.setAttribute(k,attrs[k]);return e}
function digitEl(){
 const svg=svgEl("svg",{viewBox:"0 0 12 22",class:"wa-d","aria-hidden":"true"});svg._segs={};svg._val=null;
 for(const k in SEGDEF){const [cx,cy,v]=SEGDEF[k];const poly=svgEl("polygon",{points:hexPts(cx,cy,8,2.2,v)});svg.appendChild(poly);svg._segs[k]=poly}
 return svg;
}
function setDigit(svg,ch){if(svg._val===ch)return;svg._val=ch;const on=SEG[ch]||"";for(const k in svg._segs)svg._segs[k].classList.toggle("on",on.indexOf(k)>=0)}
function colonEl(){const svg=svgEl("svg",{viewBox:"0 0 4 22",class:"wa-c","aria-hidden":"true"});svg.appendChild(svgEl("rect",{x:1,y:6,width:2.2,height:2.2}));svg.appendChild(svgEl("rect",{x:1,y:14,width:2.2,height:2.2}));return svg}
function timeEl(extra){            // [sign] m m : s s
 const root=el("span","wa-time"+(extra?" "+extra:""));
 const sign=digitEl(),m1=digitEl(),m2=digitEl(),s1=digitEl(),s2=digitEl();sign.classList.add("sign");
 root.append(sign,m1,m2,colonEl(),s1,s2);
 root.set=(secs,neg)=>{secs=Math.max(0,Math.round(secs||0));const m=Math.min(99,Math.floor(secs/60)),r=secs%60;
  setDigit(sign,neg?"-":" ");setDigit(m1,String(Math.floor(m/10)));setDigit(m2,String(m%10));setDigit(s1,String(Math.floor(r/10)));setDigit(s2,String(r%10))};
 root.set(0,false);return root;
}

/* ---- spectrum analyzer: the frames were computed from the real audio when the podcast was made ---- */
let spec=null;                                  // {fps, bands, data:Uint8Array} or null
function loadSpec(){
 spec=null;
 try{
  if(meta&&typeof meta.spec==="string"&&meta.specBands===16&&meta.specFps>0){
   const bin=atob(meta.spec),d=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)d[i]=bin.charCodeAt(i);
   if(d.length%16===0&&d.length>0)spec={fps:meta.specFps,bands:16,data:d};
  }
 }catch(_){spec=null}
}
function specFrame(t){
 if(!spec)return null;
 const frames=spec.data.length/spec.bands,f=t*spec.fps,i0=Math.min(frames-1,Math.max(0,Math.floor(f))),i1=Math.min(frames-1,i0+1),k=f-Math.floor(f);
 const out=new Float32Array(spec.bands);
 for(let b=0;b<spec.bands;b++){const a=spec.data[i0*spec.bands+b],c=spec.data[i1*spec.bands+b];out[b]=(a+(c-a)*k)/255}
 return out;
}
function makeVis(canvas){
 const ctx=canvas.getContext&&canvas.getContext("2d");
 const N=16,levels=new Float32Array(N),peaks=new Float32Array(N),hold=new Float32Array(N);
 let cols=null;
 const ROWS=14;
 function colours(){const cs=getComputedStyle(canvas);cols=[cs.getPropertyValue("--vis-low").trim()||"#0f0",cs.getPropertyValue("--vis-mid").trim()||"#ff0",cs.getPropertyValue("--vis-high").trim()||"#f00",cs.getPropertyValue("--vis-peak").trim()||"#fff",cs.getPropertyValue("--vis-off").trim()||"rgba(255,255,255,.06)"]}
 function draw(){
  if(!ctx)return;
  const dpr=window.devicePixelRatio||1,w=canvas.clientWidth||160,h=canvas.clientHeight||56;
  if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  if(!cols)colours();
  const gap=2,bw=(w-gap*(N-1))/N,rh=h/ROWS,cell=Math.max(1,rh-1);
  for(let i=0;i<N;i++){
   const x=i*(bw+gap),lit=Math.round(levels[i]*ROWS),pk=Math.round(peaks[i]*ROWS);
   for(let r=0;r<ROWS;r++){
    const y=h-(r+1)*rh+0.5,frac=r/ROWS;
    ctx.fillStyle=r<lit?(frac<0.55?cols[0]:frac<0.8?cols[1]:cols[2]):cols[4];
    ctx.fillRect(x,y,bw,cell);
   }
   if(pk>0&&pk<=ROWS){ctx.fillStyle=cols[3];ctx.fillRect(x,h-pk*rh+0.5,bw,cell)}
  }
 }
 return{
  recolor(){cols=null},
  // target: Float32Array(16) of 0..1 while playing, or null to let the bars fall
  step(target){
   for(let i=0;i<N;i++){
    const t=target?target[i]:0;
    levels[i]=t>levels[i]?t:Math.max(t,levels[i]-0.07);
    if(levels[i]>=peaks[i]){peaks[i]=levels[i];hold[i]=10}else if(hold[i]>0)hold[i]--;else peaks[i]=Math.max(0,peaks[i]-0.025);
   }
   draw();
  },
  alive(){for(let i=0;i<N;i++)if(levels[i]>0.01||peaks[i]>0.01)return true;return false},
  clear(){levels.fill(0);peaks.fill(0);hold.fill(0);draw()}
 };
}

/* ---- transcript follows the audio ---- */
function segIndex(t){const s=meta.segments;let lo=0,hi=s.length-1,r=0;while(lo<=hi){const m=(lo+hi)>>1;if(s[m].s<=t+0.05){r=m;lo=m+1}else hi=m-1}return r}
let showRemain=false,raf=0;
function onTime(){
 if(!audio||!meta)return;
 const t=audio.currentTime,dur=audio.duration||meta.seconds;
 if(ui){
  const sl=$("#pl-seek",ui.sheet);if(sl&&!sl.dataset.drag){sl.max=String(Math.round(dur));sl.value=String(Math.round(t))}
  if(!sl.dataset.drag){ui.time.set(showRemain?dur-t:t,showRemain);$("#pl-time",ui.sheet).setAttribute("aria-label",(showRemain?"Time left ":"Time played ")+fmt(showRemain?dur-t:t)+". Tap to switch.")}
  ui.miniTime.set(t,false);
  const i=segIndex(t);
  if(i!==activeIdx){
   activeIdx=i;
   ui.lines.forEach((row,k)=>{row.classList.toggle("on",k===i);row.setAttribute("aria-current",k===i?"true":"false")});
   if(S.open&&!ui.sheet.classList.contains("no-list")&&Date.now()-userScrollAt>4000){const row=ui.lines[i];if(row&&row.scrollIntoView)row.scrollIntoView({block:"center",behavior:"smooth"})}
  }
  const bar=$("#pm-bar",ui.mini);if(bar)bar.style.width=((t/dur)*100)+"%";
 }
 if(Math.abs(t-lastPos)>=5){lastPos=t;msPosition()}
}

/* ---- visualizer loop: runs only while the sheet is open, the page is visible and there is something to draw ---- */
const reduceMotion=()=>{try{return window.matchMedia("(prefers-reduced-motion: reduce)").matches}catch(_){return false}};
function visTick(){
 raf=0;
 if(!ui||!S.open||document.hidden)return;
 const playing=S.state==="playing"&&audio;
 let target=null;
 if(playing){target=specFrame(audio.currentTime);if(!target){const t=audio.currentTime;target=new Float32Array(16);for(let i=0;i<16;i++)target[i]=0.25+0.4*Math.abs(Math.sin(t*3.1+i*0.9))}}
 ui.vis.step(target);
 if(playing||ui.vis.alive())raf=requestAnimationFrame(visTick);
}
function visKick(){
 if(!ui||!S.open)return;
 if(reduceMotion()){ui.vis.step(S.state==="playing"&&audio?specFrame(audio.currentTime):null);return}
 if(!raf)raf=requestAnimationFrame(visTick);
}
document.addEventListener("visibilitychange",()=>{if(!document.hidden)visKick()});

/* ---- UI: a retro player window and a playlist window, plus a mini bar above the bottom navigation ---- */
function el(tag,cls,html){const e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e}
const GL={
 back:'<svg viewBox="0 0 16 12"><path d="M8 1v10L1 6z"/><path d="M15 1v10L8 6z"/></svg>',
 play:'<svg viewBox="0 0 16 12"><path d="M4 0.5v11L13 6z"/></svg>',
 pause:'<svg viewBox="0 0 16 12"><rect x="3" y="1" width="3.5" height="10"/><rect x="9.5" y="1" width="3.5" height="10"/></svg>',
 stop:'<svg viewBox="0 0 16 12"><rect x="3.5" y="1.5" width="9" height="9"/></svg>',
 fwd:'<svg viewBox="0 0 16 12"><path d="M1 1v10l7-5z"/><path d="M8 1v10l7-5z"/></svg>'
};
function wabtn(id,glyph,label,cls,sub){const b=el("button","wa-btn"+(cls?" "+cls:""),GL[glyph]+(sub?'<small>'+sub+'</small>':""));b.id=id;b.type="button";b.setAttribute("aria-label",label);return b}
function titlebar(text,closeId){
 const bar=el("div","wa-titlebar");bar.append(el("span","wa-grip"),el("span","wa-title",text),el("span","wa-grip"));
 if(closeId){const x=el("button","wa-x","×");x.id=closeId;x.type="button";x.setAttribute("aria-label","Close player");bar.appendChild(x)}
 return bar;
}
function buildUI(){
 if(ui||!meta)return;
 const app=$("#app"),nav=$("#nav");
 const sheet=el("section","pl-sheet wa");sheet.id="player";sheet.setAttribute("role","dialog");sheet.setAttribute("aria-label","Podcast player");sheet.hidden=true;
 let listOn=true;try{listOn=localStorage.getItem("tldr.pl.list")!=="0"}catch(_){}
 if(!listOn)sheet.classList.add("no-list");

 /* main window */
 const main=el("div","wa-win wa-main");main.appendChild(titlebar('TL<em>;</em>DR PLAYER',"pl-close"));
 const body=el("div","wa-body");
 const lcd=el("div","wa-lcd");
 const top=el("div","wa-lcd-top");
 const stateIco=el("span","wa-stateico");stateIco.id="pl-stateico";stateIco.setAttribute("aria-hidden","true");
 const timeBtn=el("button","wa-timebtn");timeBtn.id="pl-time";timeBtn.type="button";timeBtn.setAttribute("aria-label","Time. Tap to switch between time played and time left");
 const time=timeEl();timeBtn.appendChild(time);
 const vis=el("canvas","wa-vis");vis.id="pl-vis";vis.setAttribute("aria-hidden","true");
 top.append(stateIco,timeBtn,vis);
 const marq=el("div","wa-marquee");marq.id="pl-marquee";const mt=el("span","wa-marquee-txt");mt.id="pl-marquee-txt";mt.setAttribute("aria-hidden","true");marq.appendChild(mt);
 const info=el("div","wa-info");
 info.innerHTML='<span class="wa-chip" id="pl-kbps">128</span><small>KBPS</small><span class="wa-chip" id="pl-khz">44</span><small>KHZ</small><span class="wa-mode"><b>MONO</b><i>STEREO</i></span>';
 lcd.append(top,marq,info);
 const seek=el("input","wa-seek");seek.id="pl-seek";seek.type="range";seek.min="0";seek.max="100";seek.step="1";seek.value="0";seek.setAttribute("aria-label","Seek");
 const tr=el("div","wa-transport");
 tr.append(wabtn("pl-back","back","Back 15 seconds","","15"),wabtn("pl-play","play","Play","wa-play"),wabtn("pl-pause","pause","Pause"),wabtn("pl-stop","stop","Stop"),wabtn("pl-fwd","fwd","Forward 30 seconds","","30"));
 const rate=el("button","wa-tog","1X");rate.id="pl-rate";rate.type="button";rate.setAttribute("aria-label","Playback speed");
 const plb=el("button","wa-tog","PL");plb.id="pl-pl";plb.type="button";plb.setAttribute("aria-label","Show or hide the transcript");plb.setAttribute("aria-pressed",listOn?"true":"false");
 const status=el("span","wa-status");status.id="pl-status";status.setAttribute("role","status");
 tr.append(rate,plb);info.appendChild(status);
 const tip=el("div","wa-tip");tip.id="pl-tip";tip.hidden=true;tip.innerHTML='<span>Tip: allow notifications for TL;DR in Android Settings to get lock-screen controls. Audio keeps playing either way.</span>';
 const tipOk=el("button","wa-tog","OK");tipOk.id="pl-tip-ok";tipOk.type="button";tip.appendChild(tipOk);
 body.append(lcd,seek,tr,tip);main.appendChild(body);

 /* playlist window = the transcript */
 const list=el("div","wa-win wa-list");list.appendChild(titlebar("PLAYLIST"));
 const tbox=el("div","wa-plist");tbox.id="pl-trans";tbox.setAttribute("aria-label","Transcript");list.appendChild(tbox);
 sheet.append(main,list);

 /* mini bar */
 const mini=el("div","pl-mini wa wa-mini");mini.id="miniplayer";mini.hidden=true;
 const miniOpen=el("button","wa-mini-open");miniOpen.id="pm-open";miniOpen.type="button";miniOpen.setAttribute("aria-label","Open player");
 const miniTime=timeEl("small");
 const miniTxt=el("span","wa-mini-txt");miniTxt.id="pm-title";const miniSub=el("small","");miniSub.id="pm-sub";
 const mcol=el("span","wa-mini-col");mcol.append(miniTxt,miniSub);miniOpen.append(miniTime,mcol);
 const miniBtn=el("button","wa-btn wa-mini-btn");miniBtn.id="pm-toggle";miniBtn.type="button";
 const miniBar=el("span","pl-mini-bar",'<i id="pm-bar"></i>');
 mini.append(miniOpen,miniBtn,miniBar);
 app.appendChild(sheet);app.insertBefore(mini,nav);

 ui={sheet,mini,lines:[],time,miniTime,vis:makeVis(vis),marqueeTxt:mt};
 $("#pl-close",sheet).onclick=closeSheet;
 $("#pl-play",sheet).onclick=()=>{if(!audio||S.state==="idle"||S.state==="error")start();else play()};
 $("#pl-pause",sheet).onclick=pause;$("#pl-stop",sheet).onclick=stop;
 
 $("#pl-back",sheet).onclick=()=>skip(-15);$("#pl-fwd",sheet).onclick=()=>skip(30);
 $("#pl-rate",sheet).onclick=cycleRate;
 $("#pl-pl",sheet).onclick=()=>{const off=sheet.classList.toggle("no-list");plb.setAttribute("aria-pressed",off?"false":"true");try{localStorage.setItem("tldr.pl.list",off?"0":"1")}catch(_){}};
 $("#pl-time",sheet).onclick=()=>{showRemain=!showRemain;onTime()};
 miniBtn.onclick=toggle;miniOpen.onclick=openSheet;
 tipOk.onclick=()=>{try{localStorage.setItem("tldr.pl.tip","1")}catch(_){}tip.hidden=true};
 seek.addEventListener("input",()=>{seek.dataset.drag="1";time.set(showRemain?(audio&&audio.duration||meta.seconds)-(+seek.value):+seek.value,showRemain)});
 seek.addEventListener("change",()=>{delete seek.dataset.drag;if(audio)seek_(+seek.value)});
 ["touchstart","wheel","pointerdown"].forEach(ev=>tbox.addEventListener(ev,()=>{userScrollAt=Date.now()},{passive:true}));
 fillStatic();
}
const seek_=t=>seek(t);
function fillStatic(){
 if(!ui||!meta)return;
 loadSpec();
 const mins=fmt(meta.seconds);
 const text="1. "+meta.title+" ("+mins+")  ***  "+meta.hosts.A+" and "+meta.hosts.B+"  ***";
 ui.marqueeTxt.textContent=text;
 $("#pl-marquee",ui.sheet).setAttribute("aria-label",text);
 ui.marqueeTxt.style.animationDuration=Math.max(9,text.length*0.19)+"s";
 $("#pl-kbps",ui.sheet).textContent=String(Math.round((meta.bitrate||128000)/1000));
 $("#pl-khz",ui.sheet).textContent="44";
 $("#pm-title",ui.mini).textContent=meta.title;
 const tbox=$("#pl-trans",ui.sheet);tbox.textContent="";ui.lines=[];
 meta.segments.forEach((s,k)=>{
  const row=el("button","wa-row"+(s.h==="A"?" a":" b"));row.type="button";
  const n=el("span","wa-n");n.textContent=String(k+1)+".";
  const who=el("span","wa-who");who.textContent=meta.hosts[s.h];
  const txt=el("span","wa-txt");txt.textContent=s.t;
  const tm=el("span","wa-tm");tm.textContent=fmt(s.s);
  row.append(n,who,txt,tm);
  row.onclick=()=>{if(!audio||S.state==="idle"||S.state==="error"){start().then(()=>seek(s.s))}else seek(s.s)};
  tbox.appendChild(row);ui.lines.push(row);
 });
 activeIdx=-1;ui.vis.clear();
}
function updateUI(){
 if(!meta){if(ui)ui.mini.hidden=true;return}
 buildUI();
 if(ui.sheet.dataset.hash!==meta.hash){ui.sheet.dataset.hash=meta.hash;fillStatic()}
 const playing=S.state==="playing",paused=S.state==="paused";
 const play=$("#pl-play",ui.sheet),pa=$("#pl-pause",ui.sheet),stp=$("#pl-stop",ui.sheet);
 play.classList.toggle("lit",playing);pa.classList.toggle("lit",paused);stp.classList.toggle("lit",S.state==="idle"||S.state==="ended");
 play.setAttribute("aria-pressed",playing?"true":"false");pa.setAttribute("aria-pressed",paused?"true":"false");
 const sico=$("#pl-stateico",ui.sheet);sico.dataset.state=S.state;sico.innerHTML=playing?GL.play:paused?GL.pause:GL.stop;
 const mb=$("#pm-toggle",ui.mini);mb.innerHTML=playing?GL.pause:GL.play;mb.setAttribute("aria-label",playing?"Pause":"Play");
 $("#pl-rate",ui.sheet).textContent=(S.rate===1?"1":String(S.rate))+"X";
 const st=$("#pl-status",ui.sheet);
 st.textContent=S.state==="loading"?"DOWNLOADING "+Math.round(S.progress*100)+"%":S.state==="error"?S.err:S.state==="ended"?"END OF PLAYLIST":S.state==="idle"?(hasCopy()?"SAVED ON THIS DEVICE":"PRESS PLAY"):"";
 st.classList.toggle("err",S.state==="error");
 const tip=$("#pl-tip",ui.sheet);let seen=false;try{seen=localStorage.getItem("tldr.pl.tip")==="1"}catch(_){}
 tip.hidden=seen||!isNative()||!(playing||paused);
 $("#pm-sub",ui.mini).textContent=S.state==="loading"?"DOWNLOADING "+Math.round(S.progress*100)+"%":meta.hosts.A+" and "+meta.hosts.B;
 ui.mini.hidden=S.open||S.state==="idle"||S.state==="error";
 ui.sheet.classList.toggle("busy",S.state==="loading");
 onTime();visKick();
}
function updateProgressOnly(){const p=$("#pl-status",ui&&ui.sheet);if(p&&S.state==="loading")p.textContent="DOWNLOADING "+Math.round(S.progress*100)+"%"}
function openSheet(){if(!meta)return;buildUI();S.open=true;ui.sheet.hidden=false;ui.vis.recolor();requestAnimationFrame(()=>ui.sheet.classList.add("show"));updateUI();
 const b=$("#pl-play",ui.sheet);if(b&&b.focus)b.focus({preventScroll:true})}
function closeSheet(){if(!ui)return;S.open=false;ui.sheet.classList.remove("show");setTimeout(()=>{if(!S.open)ui.sheet.hidden=true},220);updateUI()}
const isOpen=()=>!!S.open;
function isNative(){try{return !!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform())}catch(_){return false}}

window.TldrPodcast={refresh,available,syncButtons,open:start,close:closeSheet,isOpen,stop,
 /* test hooks */ _state:()=>({...S,meta,hasCopy:hasCopy()})};
})();
