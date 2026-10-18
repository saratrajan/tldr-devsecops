(function(){
"use strict";
/* ---------- helpers ---------- */
const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const url=u=>/^https:\/\//i.test(u||"")?esc(u):"";
/* A story with a valid https URL is a link. Without one it is plain text: no link and no search fallback. */
const lnk=(u,cls,inner)=>{const v=url(u);return v?`<a class="${cls}" href="${v}" target="_blank" rel="noopener">${inner}</a>`:`<div class="${cls}">${inner}</div>`};
const pad=n=>String(n).padStart(2,"0");
const DOW=["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];
const MON=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const parts=d=>{const [y,m,day]=d.split("-").map(Number);const dt=new Date(Date.UTC(y,m-1,day));return {y,m:m-1,day,dow:dt.getUTCDay(),dt}};
const longDate=d=>{const p=parts(d);return `${DOW[p.dow]} · ${MON[p.m]} ${p.day}`};
const fullDate=d=>{const p=parts(d);return `${DOW[p.dow]} · ${MON[p.m]} ${p.day}, ${p.y}`};
const weekStart=d=>{const p=parts(d);const back=(p.dow+6)%7;return new Date(p.dt.getTime()-back*864e5).toISOString().slice(0,10)};
const ico={
 home:'<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>',
 archive:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/></svg>',
 search:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
 settings:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>',
 phones:'<svg viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
 left:'<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
 right:'<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>'
};

/* ---------- categories ---------- */
const CATS=[["all","All"],["infosec","InfoSec"],["it","IT"],["devops","DevOps"],["general","General"]];
const CAT_LABEL={infosec:"InfoSec",it:"IT",devops:"DevOps",general:"TLDR"};
const {catOf,storiesIn,computeCounts}=window.TldrShared;   /* same rules the feed scripts use (www/js/shared.js) */
const headlineOf=p=>p.type==="article"?p.h:p.type==="list"?(p.items[0]&&p.items[0].h)||p.title:(p.tiles[0]&&p.tiles[0].t)||p.title;
/* Stored counts from the feed when present, else the same computation on the pages (older days). */
function countsOf(e){
 if(e.counts&&typeof e.counts==="object"){const c=e.counts,total=(c.tldr|0)+(c.it|0)+(c.devops|0)+(c.infosec|0);return {counts:c,total}}
 return computeCounts(e.P)}

/* ---------- state ---------- */
let E=[];            // editions, newest first
const S={reading:false,tab:"today",date:null,filter:"all",start:0,from:"today",q:"",aq:"",pri:"all",book:null};
const store={get(k){try{return localStorage.getItem(k)}catch(_){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(_){}}};
let theme=store.get("tldr.theme")||"system";
const FEED_BASE=(store.get("tldr.feedBase")||"https://raw.githubusercontent.com/saratrajan/tldr-devsecops/main/feed/").replace(/\/?$/,"/");
const SYNC={busy:false,last:+store.get("tldr.lastSync")||0,msg:""};
const NEW=new Set();           // dates fetched from the feed that were not in the app yet
let SEEN=new Set(JSON.parse(store.get("tldr.seen")||"[]"));
const markSeen=d=>{if(NEW.delete(d)||!SEEN.has(d)){SEEN.add(d);store.set("tldr.seen",JSON.stringify([...SEEN].slice(-400)))}};

/* ---------- theme ---------- */
const mq=window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(){const dark=theme==="dark"||(theme==="system"&&mq.matches);
 document.documentElement.setAttribute("data-theme",dark?"dark":"light");
 try{const SB=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.SystemBars;if(SB)SB.setStyle({style:dark?"DARK":"LIGHT"})}catch(_){}}
mq.addEventListener&&mq.addEventListener("change",applyTheme);

/* ---------- flip book ---------- */
function pageClass(p){return p.type==="grid"?"gridpage"+(p.alt?" alt":""):p.type==="cover"?"cover":p.type==="article"?"article":"list"+(p.dark?" dark":"")}
const chipEl=pr=>`<span class="chip ${pr==="critical"?"critical":pr}">${pr==="critical"?"Critical":pr==="high"?"High":"Watch"}</span>`;
function pageHTML(p){
 if(p.type==="cover")return `<div class="grid-bg"></div><div class="grad"></div><div class="body"><div class="tag">${esc(p.tag)}</div><h1>News Brief.</h1><p class="sub">${esc(p.sub)}</p>${p.entries.length?`<ol>${p.entries.map((t,i)=>`<li><a href="#" data-go="${t[1]}"><b>${pad(i+1)}</b><span>${esc(t[0])}</span></a></li>`).join("")}</ol>`:""}<div class="by">${esc(p.by)}</div></div>`;
 if(p.type==="article")return `<div class="art ${esc(p.art)}"><div class="k"><span class="big">${esc(p.big)}</span><span class="tag">${esc(p.kicker)}</span></div></div><div class="txt"><div class="tag">${esc(p.tag)}</div><h2>${esc(p.h)}</h2><p class="drop">${esc(p.p)}</p><p class="sec">${esc(p.s)}</p><div class="more">${url(p.u)?`<a href="${url(p.u)}" target="_blank" rel="noopener">Read source</a>`:""}${url(p.u2)?`<a href="${url(p.u2)}" target="_blank" rel="noopener">${esc(p.l2)}</a>`:""}<span>${esc(p.src||"")}</span></div></div>`;
 if(p.type==="list")return `<div class="head"><div class="tag">${esc(p.tag)}</div><h2>${esc(p.title)}</h2></div><div class="items">${p.items.map(i=>lnk(i.u,"item",`<div>${chipEl(i.pr)}</div><h3>${esc(i.h)}</h3><p>${esc(i.d)}</p>`)).join("")}</div>`;
 if(p.type==="grid")return `<div class="head"><div class="tag">${esc(p.tag)}</div><h2>${esc(p.title)}</h2></div><div class="mason">${p.tiles.map(t=>lnk(t.u,"tile "+esc(t.c),`<span class="tag">${esc(t.k)}</span><h3>${esc(t.t)}</h3><p>${esc(t.d)}</p>`)).join("")}</div>`;
 return "";
}
function createBook(el,pages,start,onChange){
 el.innerHTML="";
 const N=pages.length;
 const els=pages.map((p,i)=>{const d=document.createElement("section");d.className="page "+pageClass(p);d.style.zIndex=N-i;d.innerHTML=pageHTML(p)+'<div class="shade"></div>';el.appendChild(d);return d});
 let cur=Math.max(0,Math.min(N-1,start||0)),H=el.clientHeight||600,busy=false,timer=null;
 const shadeOf=e=>e.lastElementChild;
 function setA(i,a,anim){const e=els[i];if(!e)return;e.style.transition=anim?"transform .5s cubic-bezier(.22,.8,.25,1)":"none";e.style.transform=`translateZ(0) rotateX(${a}deg)`;const s=shadeOf(e);s.style.transition=anim?"opacity .5s":"none";s.style.opacity=Math.min(.7,Math.max(0,a/180*.9))}
 function under(i,p,anim){if(i<0||i>=N)return;const s=shadeOf(els[i]);s.style.transition=anim?"opacity .5s":"none";s.style.opacity=(1-p)*.45}
 function ui(){els.forEach((e,i)=>{e.style.visibility=(i<cur-1||i>cur+1)?"hidden":"visible";e.setAttribute("aria-hidden",i===cur?"false":"true")});onChange&&onChange(cur,N)}
 function rest(){for(let i=0;i<N;i++){setA(i,i<cur?180:0,false)}under(cur+1,0,false);shadeOf(els[cur]).style.opacity=0;ui()}
 function done(){timer=setTimeout(()=>{busy=false;rest()},520)}
 function commit(d){if(d===1&&cur>=N-1||d===-1&&cur<=0)return;busy=true;
  if(d===1){setA(cur,180,true);under(cur+1,1,true);cur++}else{cur--;setA(cur,0,true);under(cur+1,0,true)}
  ui();done()}
 function snap(d){busy=true;if(d===1){setA(cur,0,true);under(cur+1,0,true)}else if(d===-1){setA(cur-1,180,true)}done()}
 function jump(n){n=Math.max(0,Math.min(N-1,n));if(n===cur||busy)return;const d=n>cur?1:-1;let k=Math.abs(n-cur);(function s(){if(k<=0)return;k--;commit(d);setTimeout(s,200)})()}
 let sy=null,sx=0,dir=0,moved=false,lastY=0,lastT=0,vel=0,pid=null;
 el.addEventListener("pointerdown",e=>{if(busy)return;const m=e.target.closest(".mason");if(m&&m.scrollHeight>m.clientHeight+2){sy=null;return}sy=e.clientY;sx=e.clientX;dir=0;moved=false;lastT=performance.now();lastY=e.clientY;vel=0;pid=e.pointerId;H=el.clientHeight});
 el.addEventListener("pointermove",e=>{if(sy===null||e.pointerId!==pid)return;const dy=e.clientY-sy,dx=e.clientX-sx;
  if(!moved){if(Math.abs(dy)<8||Math.abs(dx)>Math.abs(dy)*1.4)return;moved=true;try{el.setPointerCapture(e.pointerId)}catch(_){}}
  const nd=dy<0?1:-1;if(nd===1&&cur>=N-1||nd===-1&&cur<=0){dir=0;return}
  if(nd!==dir){if(dir===1)setA(cur,0,false);if(dir===-1)setA(cur-1,180,false);dir=nd}
  const p=Math.min(1,Math.abs(dy)/(H*.85));
  if(dir===1){setA(cur,p*180,false);under(cur+1,p,false)}else{setA(cur-1,180-p*180,false)}
  const now=performance.now();vel=(e.clientY-lastY)/Math.max(1,now-lastT);lastY=e.clientY;lastT=now});
 function end(e){if(sy===null)return;const dy=e.clientY-sy;const was=moved;sy=null;
  if(!was||!dir){if(was)rest();return}
  const p=Math.min(1,Math.abs(dy)/(H*.85));const fast=(dir===1&&vel<-.5)||(dir===-1&&vel>.5);
  if(p>.25||fast)commit(dir);else snap(dir)}
 el.addEventListener("pointerup",end);el.addEventListener("pointercancel",end);
 el.addEventListener("click",e=>{if(moved){e.preventDefault();e.stopPropagation();moved=false;return}
  const g=e.target.closest("[data-go]");if(g){e.preventDefault();jump(+g.dataset.go)}},true);
 rest();
 return {next:()=>{if(!busy)commit(1)},prev:()=>{if(!busy)commit(-1)},jump,destroy:()=>clearTimeout(timer)};
}

/* ---------- views ---------- */
const view=$("#view"),nav=$("#nav");
function renderNav(){const items=[["today","Today",ico.home],["archive","Archive",ico.archive],["search","Search",ico.search],["settings","Settings",ico.settings]];
 nav.hidden=S.reading;nav.innerHTML=items.map(([k,n,i])=>`<button class="navitem ${S.tab===k?"active":""}" data-tab="${k}" aria-label="${n}"${S.tab===k?' aria-current="page"':""}>${i}<span>${n}</span></button>`).join("")}
nav.addEventListener("click",e=>{const b=e.target.closest("[data-tab]");if(!b)return;S.tab=b.dataset.tab;if(S.tab==="today"){S.reading=false}S.reading=false;render()});

function topline(right){return `<div class="topline"><div class="wordmark">TL<em>;</em>DR</div>${right||""}</div>`}
const latest=()=>E[0];

function viewToday(){
 const e=latest();if(!e){view.innerHTML=`<div class="content">${topline()}<p class="empty">No editions saved yet.</p></div>`;return}
 const st=e.P.reduce((a,p)=>a+storiesIn(p),0);
 view.innerHTML=`<div class="content">${topline(`<button class="iconbtn" data-act="archive" aria-label="Open archive">${ico.archive}</button>`)}
 <button class="cover-card" data-act="read-latest" aria-label="Open today's edition"><div class="date-tag">${esc(fullDate(e.date))}</div><h2>News<br>Brief.</h2><p>Four newsletters. One ranked read. All yours, offline.</p><ol class="rank-list">${e.TOP.slice(0,4).map((t,i)=>`<li><b>${pad(i+1)}</b><span>${esc(t[0])}</span></li>`).join("")}</ol><div class="cover-foot"><span>${st} stories · ${e.P.length+1} pages</span><span>Open edition ↗</span></div></button>
 <div class="todayfoot"><span class="mono muted">Your daily briefing</span><span class="todayacts"><button class="pill pill-listen" data-act="listen" data-listen data-date="${e.date}" hidden><span class="pl-ico">${ico.phones}</span><span data-listen-label>Listen</span></button><button class="pill" data-act="read-latest">Read today →</button></span></div></div>`;
}
view.addEventListener("click",e=>{
 const a=e.target.closest("[data-act]");if(!a)return;
 const act=a.dataset.act;
 if(act==="back"){S.reading=false;S.tab=S.from||"today";render()}
 if(act==="archive"){S.tab="archive";S.reading=false;render()}
 else if(act==="read-latest"){openReader(latest().date,0,"all","today")}
 else if(act==="read"){openReader(a.dataset.date,+a.dataset.page||0,"all",S.tab)}
 else if(act==="sync"){doSync(true)}
 else if(act==="listen"){window.TldrPodcast&&window.TldrPodcast.open()}
});

function viewArchive(){
 const q=S.aq.trim().toLowerCase();
 const rows=E.filter(e=>!q||(e.date+" "+longDate(e.date)+" "+e.TOP.map(t=>t[0]).join(" ")+" "+e.P.map(headlineOf).join(" ")).toLowerCase().includes(q));
 let lastWk="",html="";const wk0=weekStart(E[0]?E[0].date:"1970-01-01");
 rows.forEach(e=>{const w=weekStart(e.date);if(w!==lastWk){lastWk=w;const p=parts(w);html+=`<div class="weekhead">${w===wk0?"This week":"Week of "+MON[p.m]+" "+p.day}</div>`}
  const p=parts(e.date),cc=countsOf(e),c=cc.counts;
  html+=`<button class="archive-row" data-act="read" data-date="${e.date}"><div class="dateblock"><b>${p.day}</b><span>${DOW[p.dow].slice(0,3)} · ${MON[p.m]}</span></div><div><h3>${NEW.has(e.date)?'<span class="newpill">New</span> ':""}${esc(e.TOP[0]?e.TOP[0][0]:headlineOf(e.P[0]))}</h3><div class="counts"><span class="count">${cc.total} stories</span>${[["tldr","TLDR"],["it","IT"],["devops","DevOps"],["infosec","InfoSec"]].filter(([k])=>c[k]).map(([k,n])=>`<span class="count">${n} ${c[k]}</span>`).join("")}</div></div></button>`});
 view.innerHTML=`<div class="content">${topline(`<span class="mono muted">${E.length} days saved</span>`)}<h2 class="sectionhead">The archive.</h2><p class="subhead">Every edition, kept on your device.</p>
 <label class="searchbox">${ico.search}<input id="aq" type="search" placeholder="Find a day or headline" value="${esc(S.aq)}" autocomplete="off"></label>
 <div class="scroller" id="rows">${html||'<p class="empty">No day matches that.</p>'}</div><div class="mono muted" style="padding-top:8px">Newest first · offline</div></div>`;
 const inp=$("#aq");inp.addEventListener("input",()=>{S.aq=inp.value;const pos=inp.selectionStart;viewArchive();const n=$("#aq");n.focus();n.setSelectionRange(pos,pos)});
}

/* search index */
let INDEX=null;
function buildIndex(){INDEX=[];E.forEach(e=>e.P.forEach((p,pi)=>{
 const nl=CAT_LABEL[catOf(p)];
 const push=(h,d,pr,link)=>INDEX.push({date:e.date,page:pi+1,nl,h,d,pr,link,txt:(h+" "+d).toLowerCase()});
 if(p.type==="article")push(p.h,p.p,p.art==="a1"?"critical":"high",p.u);
 else if(p.type==="list")p.items.forEach(i=>push(i.h,i.d,i.pr,i.u));
 else if(p.type==="grid")p.tiles.forEach(t=>push(t.t,t.d,"watch",t.u));}))}
const PRI_ORDER={critical:0,high:1,watch:2};
function viewSearch(){
 if(!INDEX)buildIndex();
 view.innerHTML=`<div class="content">${topline(`<span class="mono muted">${E.length} editions</span>`)}<h2 class="sectionhead">Find the signal.</h2><p class="subhead">Search every saved story, across every day.</p>
 <label class="searchbox">${ico.search}<input id="sq" type="search" placeholder="Try ‘Kubernetes’ or ‘agents’" value="${esc(S.q)}" autocomplete="off"></label>
 <div class="mono muted" style="margin-bottom:8px">Priority</div>
 <div class="chips" id="pri">${[["all","All"],["critical","Critical"],["high","High"],["watch","Watch"]].map(([k,n])=>`<button class="pill ${S.pri===k?"active":""}" data-pri="${k}">${n}</button>`).join("")}</div>
 <div class="scroller" id="results"></div></div>`;
 const inp=$("#sq");inp.addEventListener("input",()=>{S.q=inp.value;results()});
 $("#pri").addEventListener("click",e=>{const b=e.target.closest("[data-pri]");if(!b)return;S.pri=b.dataset.pri;[...$("#pri").children].forEach(x=>x.classList.toggle("active",x===b));results()});
 results();
}
function results(){
 const terms=S.q.toLowerCase().split(/\s+/).filter(Boolean);
 let r=INDEX.filter(x=>(S.pri==="all"||x.pr===S.pri)&&terms.every(t=>x.txt.includes(t)));
 r.sort((a,b)=>b.date.localeCompare(a.date)||PRI_ORDER[a.pr]-PRI_ORDER[b.pr]);
 const total=r.length;r=r.slice(0,80);
 const p=x=>parts(x.date);
 $("#results").innerHTML=r.length?r.map(x=>`<button class="feedcard" data-act="read" data-date="${x.date}" data-page="${x.page}"><div class="meta"><span class="newsletter">${esc(x.nl)} · ${MON[p(x).m]} ${p(x).day}</span>${chipEl(x.pr)}</div><h3>${esc(x.h)}</h3><p>${esc(x.d)}</p></button>`).join("")+(total>r.length?`<p class="empty">Showing ${r.length} of ${total}. Narrow the search to see the rest.</p>`:""):'<p class="empty">Nothing matches. Try a shorter word or clear the priority filter.</p>';
}

/* App version comes from the installed APK (versionName in android/app/build.gradle), never hardcoded. */
const VER={name:"",build:""};
function verText(){return VER.name?"v"+VER.name:""}
(async()=>{try{const App=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;
 if(App&&App.getInfo){const i=await App.getInfo();VER.name=String(i.version||"");VER.build=String(i.build||"");if(!S.reading&&S.tab==="settings")viewSettings()}}catch(_){}})();
function viewSettings(){
 const seg=(k,n)=>`<button class="${theme===k?"on":""}" data-theme-set="${k}">${n}</button>`;
 view.innerHTML=`<div class="content">${topline('<span class="mono muted">Preferences</span>')}<h2 class="sectionhead">Make it yours.</h2><p class="subhead">A quiet reading space, tuned to you.</p>
 <div class="settingsrow"><div><strong>Appearance</strong><small>Choose your reading paper</small></div><div class="segmented">${seg("light","Light")}${seg("dark","Dark")}${seg("system","System")}</div></div>
 <div class="settingsrow"><div><strong>Latest editions</strong><small id="syncmsg">${esc(syncText())}</small></div><button class="pill" data-act="sync">${SYNC.busy?"Checking…":"Refresh"}</button></div>
 <div class="settingsrow"><div><strong>Saved on this device</strong><small>Readable offline</small></div><span class="pill">${E.length} saved</span></div>
 <div class="settingsrow"><div><strong>Newsletters</strong><small>TLDR · IT · DevOps · InfoSec</small></div><span style="font-size:20px;color:var(--teal)">✓</span></div>
 <div class="settingsrow"><div><strong>About TL;DR</strong><small>One day. One ranked read.</small></div><span class="muted">${esc(verText())}</span></div>
 <div class="about"><div class="mono muted">${VER.name?`Version ${esc(VER.name)}${VER.build?` (${esc(VER.build)})`:""} · `:""}Made for reading</div><p>Your daily tech brief, assembled from the newsletters you follow. No feeds to chase. No connection required to read.</p></div></div>`;
 view.querySelectorAll("[data-theme-set]").forEach(b=>b.addEventListener("click",()=>{theme=b.dataset.themeSet;store.set("tldr.theme",theme);applyTheme();viewSettings()}));
}

/* reader */
function coverFor(e,f){
 const pages=e.P;const fp=f==="all"?pages:pages.filter(p=>catOf(p)===f);
 const tag=f==="all"?fullDate(e.date):`${fullDate(e.date)} · ${CAT_LABEL[f]||""}`;
 let entries,sub;
 if(f==="all"){entries=e.TOP.slice(0,4).map(t=>[t[0],t[1]]);sub=`${fp.reduce((a,p)=>a+storiesIn(p),0)} stories from four newsletters, ranked by priority.`}
 else{entries=fp.slice(0,4).map((p,i)=>[headlineOf(p),i+1]);sub=fp.length?`${fp.reduce((a,p)=>a+storiesIn(p),0)} ${CAT_LABEL[f]} stories in this edition.`:`No ${CAT_LABEL[f]} stories in this edition.`}
 return {pages:[{type:"cover",tag,sub,entries,by:"By TLDR · curated for you"},...fp],total:fp.length+1};
}
function openReader(date,page,filter,from){markSeen(date);S.date=date;S.start=page||0;S.filter=filter||"all";S.from=from||"today";S.reading=true;render()}
function viewReader(){
 const e=E.find(x=>x.date===S.date)||E[0];S.date=e.date;
 const isLatest=e===E[0];
 view.innerHTML=`<div class="reader"><div class="reader-bar"><button class="iconbtn" data-act="back" aria-label="Back">${ico.left}</button><div class="chips" id="cats">${CATS.map(([k,n])=>`<button class="pill ${S.filter===k?"active":""}" data-cat="${k}">${n}</button>`).join("")}</div><button class="iconbtn" data-act="listen" data-listen data-date="${e.date}" aria-label="Listen as podcast" hidden>${ico.phones}</button></div>
 <div class="reader-stage"><div class="book" id="book"></div><div class="reader-hint" id="hint">Swipe up to turn the page</div></div>
 <div class="reader-controls"><button class="arrowbtn" id="prev" aria-label="Previous page">${ico.left}</button><span class="pagecount" id="pc"></span><div class="progress"><span id="pg"></span></div><button class="arrowbtn" id="next" aria-label="Next page">${ico.right}</button></div></div>`;
 const build=(start)=>{if(S.book)S.book.destroy();const c=coverFor(e,S.filter);
  S.book=createBook($("#book"),c.pages,start,(cur,N)=>{$("#pc").textContent=`${pad(cur+1)} / ${pad(N)}`;$("#hint").hidden=cur>0;$("#pg").style.width=((cur+1)/N*100)+"%";$("#prev").disabled=cur===0;$("#next").disabled=cur===N-1;S.start=cur})};
 $("#cats").addEventListener("click",x=>{const b=x.target.closest("[data-cat]");if(!b)return;S.filter=b.dataset.cat;[...$("#cats").children].forEach(y=>y.classList.toggle("active",y===b));build(0)});
 $("#prev").onclick=()=>S.book.prev();$("#next").onclick=()=>S.book.next();
 build(S.start);
}

/* ---------- router ---------- */
function render(){
 if(S.book){S.book.destroy();S.book=null}
 renderNav();
 if(S.reading)viewReader();
 else ({today:viewToday,archive:viewArchive,search:viewSearch,settings:viewSettings})[S.tab]();
 if(window.TldrPodcast)window.TldrPodcast.syncButtons();
}
/* Listen exists only for the latest edition, and only once its podcast has been published. */
function podcastRefresh(){if(window.TldrPodcast&&E[0])window.TldrPodcast.refresh(E[0].date)}

/* Android back button */
try{const App=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;
 App&&App.addListener("backButton",()=>{
  if(window.TldrPodcast&&window.TldrPodcast.isOpen()){window.TldrPodcast.close()}
  else if(S.reading){S.reading=false;S.tab=S.from||"today";render()}
  else if(S.tab!=="today"){S.tab="today";render()}
  else App.exitApp()})}catch(_){}

/* ---------- feed sync ---------- */
function syncText(){const t=SYNC.last?new Date(SYNC.last).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"never";return SYNC.msg||("Last checked: "+t)}
function toast(msg){let t=$("#toast");if(!t){t=document.createElement("div");t.id="toast";t.setAttribute("role","status");$("#app").appendChild(t)}t.textContent=msg;t.className="show";clearTimeout(toast.t);toast.t=setTimeout(()=>{t.className=""},2600)}
function mergeRecords(recs){
 const byDate=new Map(E.map(e=>[e.date,e]));let fresh=0;
 recs.forEach(r=>{const had=byDate.has(r.date);byDate.set(r.date,{date:r.date,P:r.data.P,TOP:r.data.TOP,hash:r.hash,counts:r.data.counts});if(!had&&!SEEN.has(r.date)){NEW.add(r.date);fresh++}});
 E=[...byDate.values()].sort((a,b)=>b.date.localeCompare(a.date));INDEX=null;return fresh;
}
async function doSync(manual){
 if(SYNC.busy||!window.TldrSync)return;
 SYNC.busy=true;SYNC.msg="Checking for new editions…";if(!S.reading&&S.tab==="settings")viewSettings();
 const have={};E.forEach(e=>{if(e.hash)have[e.date]=e.hash});
 try{
  const r=await window.TldrSync.sync(FEED_BASE,have);
  const fresh=mergeRecords(r.added);
  SYNC.last=Date.now();store.set("tldr.lastSync",String(SYNC.last));SYNC.msg="";
  if(r.added.length){if(!S.reading&&S.tab!=="search")render();toast(fresh?`${fresh} new edition${fresh>1?"s":""}`:"Editions updated")}
  else if(manual)toast(r.skipped?"Some editions were skipped (invalid)":"You're up to date")
 }catch(err){
  SYNC.msg="Couldn't reach the feed. Showing saved editions.";
  if(manual)toast(SYNC.msg);
 }finally{SYNC.busy=false;if(!S.reading&&S.tab==="settings")viewSettings();SYNC.msg=SYNC.msg&&SYNC.msg.startsWith("Couldn")?SYNC.msg:"";podcastRefresh()}
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible")return;podcastRefresh();if(Date.now()-SYNC.last>30*60*1000)doSync(false)});
/* pull down on Today or Archive to refresh */
(function(){let y0=null,top=false;
 view.addEventListener("touchstart",e=>{if(S.reading||(S.tab!=="today"&&S.tab!=="archive")){y0=null;return}const sc=e.target.closest(".scroller");top=!sc||sc.scrollTop<=0;y0=top?e.touches[0].clientY:null},{passive:true});
 view.addEventListener("touchend",e=>{if(y0===null)return;const dy=e.changedTouches[0].clientY-y0;y0=null;if(dy>90)doSync(true)},{passive:true});
})();

/* ---------- boot ---------- */
applyTheme();
async function boot(){
 let bundled=[];
 try{bundled=await fetch("data/editions.json").then(r=>r.json())}catch(err){view.innerHTML=`<div class="content"><p class="empty">Could not load the saved editions. ${esc(err&&err.message)}</p></div>`;return}
 E=bundled.slice();
 try{const cached=await window.TldrSync.all();const ok=cached.filter(c=>c&&window.TldrSync.validDay(c.data));if(ok.length)mergeRecords(ok)}catch(_){}
 NEW.clear();render();podcastRefresh();doSync(false);
}
boot();
})();
