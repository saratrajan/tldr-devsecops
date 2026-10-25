#!/usr/bin/env node
// Lints a finished podcast: node scripts/lint-podcast.js podcast.json [latest.mp3]
// With no mp3 argument it looks for latest.mp3 next to podcast.json.
const fs=require('fs'),path=require('path');
const {lintMeta}=require('./lib/podcast');
const f=process.argv[2];
if(!f){console.error('usage: lint-podcast.js podcast.json [latest.mp3]');process.exit(1)}
let meta;try{meta=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){console.error('PODCAST LINT FAIL: cannot read or parse '+f);process.exit(1)}
const mp3=process.argv[3]||path.join(path.dirname(f),'latest.mp3');
const r=lintMeta(meta,mp3);
r.warnings.forEach(w=>console.log('warn: '+w));
if(!r.ok){r.errors.forEach(e=>console.error('error: '+e));console.error('PODCAST LINT FAIL');process.exit(1)}
console.log(`PODCAST LINT OK: ${meta.date}, ${(meta.seconds/60).toFixed(1)} min, ${(meta.bytes/1e6).toFixed(1)} MB, ${meta.segments.length} turns, ${meta.segments.reduce((n,x)=>n+x.t.length,0)} characters`);
