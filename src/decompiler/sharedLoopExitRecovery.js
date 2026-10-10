'use strict';

// A local loop break skips the update/test exactly like the original nonlocal
// exit. Accept only an empty terminal corridor or a direct same-frame break.
// Never cross work, cleanup, another loop or a switch after the selected loop.
function foldSharedLoopFrameExits(source, proof, {retainDiagnostics=false}={}){
 const unchanged=()=>({source,breaksLocalized:0});
 if(!proof||typeof retainDiagnostics!=='boolean'||source.length>400000)return unchanged();
 const{parsed,tokens,starts,closes,children,labelCounts}=proof;if([...labelCounts.values()].some(n=>n!==1))return unchanged();
 const loops=new Set(['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement']),parents=new Map(),targets=new Map(),nearest=new Map(),jumps=[];let refused=false;
 function visit(n,parent=null,labels=[],breaks=[],loopStack=[],depth=0){if(depth>128){refused=true;return;}parents.set(n,parent);if(/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(n.kind||'')||n.kind==='NewClassExpression'&&n.body!=null)refused=true;
  if(['BreakStatement','ContinueStatement'].includes(n.kind)){const t=n.label?labels.slice().reverse().find(x=>x.label===n.label):n.kind==='ContinueStatement'?loopStack.at(-1):breaks.at(-1);if(!t||n.kind==='ContinueStatement'&&n.label&&!loops.has(t.statement?.kind))refused=true;else{targets.set(n,t);nearest.set(n,breaks.at(-1));if(n.kind==='BreakStatement'&&n.label)jumps.push(n);}}
  children(n,c=>visit(c,n,n.kind==='LabeledStatement'?[...labels,n]:labels,loops.has(n.kind)||n.kind==='SwitchStatement'?[...breaks,n]:breaks,loops.has(n.kind)?[...loopStack,n]:loopStack,depth+1));
 }visit(parsed);if(refused)return unchanged();const range=(a,b)=>({start:tokens[a].range.startOffset-2,end:tokens[b].range.endOffset-2});const edits=[],selections=[];
 for(const jump of jumps){const frame=targets.get(jump),loop=nearest.get(jump);if(frame?.statement?.kind!=='BlockStatement'||!loops.has(loop?.kind))continue;
  let cursor=loop,valid=true,bridge=null,corridor=[];
  while(cursor!==frame.statement){const p=parents.get(cursor);if(!p){valid=false;break;}
   if(p.kind==='BlockStatement'){const i=p.statements.indexOf(cursor),rest=p.statements.slice(i+1);if(i<0){valid=false;break;}if(rest.length){const last=rest[0],first=starts.get(last?.range?.startOffset);if(rest.length!==1||last.kind!=='BreakStatement'||last.label!==frame.label||targets.get(last)!==frame||tokens[first]?.text!=='break'||tokens[first+1]?.text!==frame.label||tokens[first+2]?.text!==';'){valid=false;break;}bridge=range(first,first+2);break;}}
   else if(p.kind==='IfStatement'){if(![p.consequent,p.alternate].includes(cursor)){valid=false;break;}}
   else if(p.kind==='LabeledStatement'){if(p.statement!==cursor||cursor.kind!=='BlockStatement'){valid=false;break;}}
   else{valid=false;break;}corridor.push(p.kind);cursor=p;
  }
  if(!valid||!bridge&&cursor!==frame.statement)continue;const first=starts.get(jump.range?.startOffset),lf=starts.get(loop.range?.startOffset),label=starts.get(frame.range?.startOffset),close=closes.get(starts.get(frame.statement.range?.startOffset));
  if(tokens[first]?.text!=='break'||tokens[first+1]?.text!==jump.label||tokens[first+2]?.text!==';'||tokens[label]?.text!==frame.label||tokens[close]?.text!=='}'||lf===undefined)continue;
  edits.push({start:tokens[first].range.endOffset-2,end:tokens[first+1].range.endOffset-2,text:''});selections.push({jumpRange:range(first,first+2),frameRange:range(label,close),loopStart:tokens[lf].range.startOffset-2,loopKind:loop.kind,label:frame.label,bridgeRange:bridge,corridorKinds:corridor});
 }
 if(!edits.length)return unchanged();edits.sort((a,b)=>b.start-a.start);let result=source;for(const e of edits)result=result.slice(0,e.start)+result.slice(e.end);return{source:result,breaksLocalized:edits.length,...(retainDiagnostics?{diagnostics:{edits,selections}}:{})};
}
module.exports={foldSharedLoopFrameExits};
