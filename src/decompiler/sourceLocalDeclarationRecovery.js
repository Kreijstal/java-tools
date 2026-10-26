'use strict';
const {JavaParser}=require('../java-frontend/parser');
const {tokenizeJava}=require('../java-frontend/lexer');
const parser=new JavaParser();

// Reuse default method-body proofs on a pinned, already generated source
// unit. Only direct type members have global parser offsets: never descend
// into anonymous/local classes or lambdas parsed from expression substrings.
function recoverCompilationUnitBodies(source,recoverBody,bodyCounter,counters) {
  const empty=()=>Object.fromEntries([bodyCounter,...counters].map(key=>[key,0]));
  const counts=empty();
  const unchanged=()=>({source,...counts});
  if(typeof source!=='string'||/\\u+[0-9a-fA-F]{4}/.test(source))return unchanged();
  let document,tokens;
  try{
    document=parser.parseCompilationUnit(source);
    const lexed=tokenizeJava(source);
    if(document.diagnostics.length||lexed.diagnostics.length)return unchanged();
    tokens=lexed.tokens.filter(t=>!['whitespace','comment','eof'].includes(t.kind));
  }catch(_){return unchanged();}
  if(tokens.some(t=>t.text.startsWith('"""')))return unchanged();
  const starts=new Map(tokens.map((t,i)=>[t.range.startOffset,i])),closes=new Map(),stack=[];
  for(let i=0;i<tokens.length;i++){
    const text=tokens[i].text;
    if(['(','[','{'].includes(text))stack.push(i);
    else if([')',']','}'].includes(text)){
      const open=stack.pop();
      if(open===undefined||'([{'.indexOf(tokens[open].text)!==')]}'.indexOf(text))return unchanged();
      closes.set(open,i);
    }
  }
  if(stack.length)return unchanged();
  const edits=[],types=new Set(['ClassDeclaration','InterfaceDeclaration','EnumDeclaration','RecordDeclaration']);
  function visit(type){
    if(!types.has(type.kind))return;
    for(const member of type.body||[]){
      if(types.has(member.kind)){visit(member);continue;}
      if(!['MethodDeclaration','ConstructorDeclaration','InitializerBlock'].includes(member.kind)
          ||member.body?.kind!=='BlockStatement'||!member.body.statements?.length)continue;
      const first=starts.get(member.body.statements[0].range?.startOffset),open=first-1,close=closes.get(open);
      if(first===undefined||tokens[open]?.text!=='{'||close===undefined)continue;
      const start=tokens[open].range.endOffset,end=tokens[close].range.startOffset;
      const body=source.slice(start,end),result=recoverBody(body,{reservedNames:(member.parameters||[]).map(p=>p.name)});
      if(result.source===body)continue;
      edits.push({start,end,text:result.source});
      counts[bodyCounter]++;
      for(const key of counters)counts[key]+=result[key];
    }
  }
  try{for(const type of document.root.typeDeclarations||[])visit(type);}catch(error){
    if(error instanceof RangeError)return {source,...empty()};
    throw error;
  }
  const fragments=[];let cursor=0;
  for(const edit of edits.sort((a,b)=>a.start-b.start)){
    if(edit.start<cursor)return {source,...empty()};
    fragments.push(source.slice(cursor,edit.start),edit.text);cursor=edit.end;
  }
  fragments.push(source.slice(cursor));
  return {source:fragments.join(''),...counts};
}
module.exports={recoverCompilationUnitBodies};
