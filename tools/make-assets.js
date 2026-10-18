// Renders launcher icons and splash screens with the bundled fonts. Run: node tools/make-assets.js <path-to-playwright>
const {chromium}=require(process.argv[2]||'playwright');const fs=require('fs'),path=require('path');
const res=path.join(__dirname,'..','android','app','src','main','res');
const dens={mdpi:1,hdpi:1.5,xhdpi:2,xxhdpi:3,xxxhdpi:4};
(async()=>{
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
 const pg=await b.newPage();
 await pg.goto('file://'+path.join(__dirname,'icons.html'));
 async function shot(w,h,html,file,transparent){
  await pg.setViewportSize({width:w,height:h});
  await pg.evaluate(([html])=>{document.body.innerHTML=html},[html]);
  await pg.evaluate(()=>document.fonts.ready);await pg.waitForTimeout(150);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  await pg.screenshot({path:file,omitBackground:!!transparent});
 }
 for(const [d,k] of Object.entries(dens)){
  const fg=108*k,leg=48*k;
  // adaptive foreground: wordmark inside the 66% safe zone, transparent
  await shot(fg,fg,`<div class="c" style="width:${fg}px;height:${fg}px"><div class="w" style="font-size:${fg*0.30}px">TL<em>;</em>DR</div></div>`,`${res}/mipmap-${d}/ic_launcher_foreground.png`,true);
  // legacy square + round icons
  const tile=(r)=>`<div class="c navy" style="width:${leg}px;height:${leg}px;border-radius:${r}"><div class="grid" style="background-size:${leg/5}px ${leg/5}px"></div><div class="w" style="position:relative;font-size:${leg*0.34}px">TL<em>;</em>DR</div></div>`;
  await shot(leg,leg,tile(leg*0.22+'px'),`${res}/mipmap-${d}/ic_launcher.png`,true);
  await shot(leg,leg,tile('50%'),`${res}/mipmap-${d}/ic_launcher_round.png`,true);
 }
 // splash (portrait + landscape) for every density folder the Capacitor template ships
 const splash=(w,h)=>`<div class="c navy" style="width:${w}px;height:${h}px"><div class="grid" style="background-size:60px 60px;-webkit-mask-image:linear-gradient(#000,transparent 75%)"></div><div style="position:relative;text-align:center"><div class="w" style="font-size:${Math.min(w,h)*0.2}px">TL<em>;</em>DR</div><div class="line">The signal, in brief.</div></div></div>`;
 await shot(1080,1920,splash(1080,1920),'/tmp/splash-port.png');
 await shot(1920,1080,splash(1920,1080),'/tmp/splash-land.png');
 for(const d of Object.keys(dens)){
  fs.copyFileSync('/tmp/splash-port.png',`${res}/drawable-port-${d}/splash.png`);
  fs.copyFileSync('/tmp/splash-land.png',`${res}/drawable-land-${d}/splash.png`);
 }
 fs.copyFileSync('/tmp/splash-port.png',`${res}/drawable/splash.png`);
 await b.close();console.log('assets done');
})();
