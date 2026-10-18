/* Rules shared by the app (browser) and the feed scripts (Node), so both always agree.
   Category rule: page tag starting "Security" or "TLDR InfoSec" = infosec, "TLDR IT" = it,
   "TLDR DevOps" = devops, anything else = general (stored as "tldr" in counts). */
(function(root,factory){
  if(typeof module==="object"&&module.exports)module.exports=factory();
  else root.TldrShared=factory();
})(typeof self!=="undefined"?self:this,function(){
  function catOf(p){const t=(p&&p.tag)||"";
    if(/^Security/.test(t)||/^TLDR InfoSec/.test(t))return "infosec";
    if(/^TLDR IT/.test(t))return "it";
    if(/^TLDR DevOps/.test(t))return "devops";
    return "general"}
  const storiesIn=p=>!p?0:p.type==="article"?1:p.type==="list"?p.items.length:p.type==="grid"?p.tiles.length:0;
  function computeCounts(P){
    const counts={tldr:0,it:0,devops:0,infosec:0};
    (P||[]).forEach(p=>{const k=catOf(p);counts[k==="general"?"tldr":k]+=storiesIn(p)});
    return {counts,total:counts.tldr+counts.it+counts.devops+counts.infosec};
  }
  return {catOf,storiesIn,computeCounts};
});
