'use strict';

// Only replace horizontal trivia immediately after an opening brace when the
// block already spans lines. Every Java token and quoted value stays exact.
function splitMultilineBlockHeaders(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged=()=>({source,headersSplit:0});
  if(!proof||typeof retainDiagnostics!=='boolean'||source.length>400000)return unchanged();
  const {tokens,closes}=proof,edits=[];
  for(let i=0;i<tokens.length-1;i++){
    const open=tokens[i],next=tokens[i+1],close=tokens[closes.get(i)];
    if(open.text!=='{'||!close||next.text==='}'||open.range.endOffset<2||close.range.endOffset-2>source.length||open.range.start.line!==next.range.start.line)continue;
    const start=open.range.endOffset-2,end=next.range.startOffset-2,gap=source.slice(start,end);
    if(!/^[ \t]*$/.test(gap)||!source.slice(end,close.range.startOffset-2).includes('\n'))continue;
    edits.push({start,end,text:'\n'});
  }
  if(!edits.length)return unchanged();edits.sort((a,b)=>b.start-a.start);let result=source;for(const e of edits)result=result.slice(0,e.start)+e.text+result.slice(e.end);
  return{source:result,headersSplit:edits.length,...(retainDiagnostics?{diagnostics:{edits}}:{})};
}
module.exports={splitMultilineBlockHeaders};
