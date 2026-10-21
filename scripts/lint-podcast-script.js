#!/usr/bin/env node
// Lints a two-host podcast script before any audio is made. Usage: node scripts/lint-podcast-script.js script.txt
const fs=require('fs');
const {lintScript}=require('./lib/podcast');
const f=process.argv[2];
if(!f){console.error('usage: lint-podcast-script.js script.txt');process.exit(1)}
let text;try{text=fs.readFileSync(f,'utf8')}catch(e){console.error('SCRIPT LINT FAIL: cannot read '+f);process.exit(1)}
const r=lintScript(text);
r.warnings.forEach(w=>console.log('warn: '+w));
if(!r.ok){r.errors.forEach(e=>console.error('error: '+e));console.error('SCRIPT LINT FAIL');process.exit(1)}
console.log(`SCRIPT LINT OK: ${r.stats.turns} turns, ${r.stats.words} words, ${r.stats.chars} characters, about ${r.stats.minutes} min`);
