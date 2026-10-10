'use strict';
const {JavaParser}=require('../java-frontend/parser');
const parser=new JavaParser();

// Equality always produces a primitive Boolean, even when its operands are
// boxed or references. Complement only that operator; preserve both operand
// expressions, their order and the original parentheses. Relational inverses
// and double-negation removal on unknown/boxed atoms are outside this contract.
function simplifyNegatedEqualityValues(source,proof,{retainDiagnostics=false}={}){
 const unchanged=()=>({source,equalitiesSimplified:0});
 if(!proof||typeof retainDiagnostics!=='boolean'||source.length>400000)return unchanged();
 const {tokens,closes}=proof;
 for(let i=0;i<tokens.length-2;i++){
  if(tokens[i].text!=='!'||tokens[i+1].text!=='(')continue;
  const close=closes.get(i+1);if(close===undefined)continue;
  let first=i+2,end=close;
  while(tokens[first]?.text==='('&&closes.get(first)===end-1){first++;end--;}
  if(first>=end)continue;
  const start=tokens[first].range.startOffset-2,finish=tokens[end-1].range.endOffset-2;
  let expression;
  try{expression=parser.parseExpression(source.slice(start,finish),{requireComplete:true});}catch(_){continue;}
  if(expression?.kind!=='BinaryExpression'||!['==','!='].includes(expression.operator))continue;
  let operator=-1;
  for(let j=first;j<end;j++){
   if(closes.has(j)){j=closes.get(j);continue;}
   if(['==','!='].includes(tokens[j].text))operator=j;
  }
  if(operator<0||tokens[operator].text!==expression.operator)continue;
  const edits=[{start:tokens[i].range.startOffset-2,end:tokens[i].range.endOffset-2,text:''},
   {start:tokens[operator].range.startOffset-2,end:tokens[operator].range.endOffset-2,text:expression.operator==='=='?'!=':'=='}].sort((a,b)=>b.start-a.start);
  let result=source;for(const e of edits)result=result.slice(0,e.start)+e.text+result.slice(e.end);
  return {source:result,equalitiesSimplified:1,...(retainDiagnostics?{diagnostics:{range:{start:tokens[i].range.startOffset-2,end:tokens[close].range.endOffset-2},operatorRange:{start:tokens[operator].range.startOffset-2,end:tokens[operator].range.endOffset-2},originalOperator:expression.operator,edits}}:{})};
 }
 return unchanged();
}
module.exports={simplifyNegatedEqualityValues};
