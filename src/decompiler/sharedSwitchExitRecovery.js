'use strict';

// A nested switch can share a plain frame's continuation through only terminal
// blocks/if arms, final case fallthrough, or one direct enclosing-switch break.
// Never move work or cross a cleanup/loop boundary between these destinations.
function foldSharedSwitchFrameExits(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, breaksLocalized: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed,tokens,starts,closes,children,labelCounts}=proof;
  if([...labelCounts.values()].some(n=>n!==1))return unchanged();
  const loops=new Set(['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement']),parents=new Map(),targets=new Map(),nearest=new Map(),jumps=[];let refused=false;
  function visit(n,parent=null,labels=[],breaks=[],loopStack=[],depth=0){
    if(depth>128){refused=true;return;}parents.set(n,parent);
    if(/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(n.kind||'')||n.kind==='NewClassExpression'&&n.body!=null)refused=true;
    if(['BreakStatement','ContinueStatement'].includes(n.kind)){const target=n.label?labels.slice().reverse().find(x=>x.label===n.label):n.kind==='ContinueStatement'?loopStack.at(-1):breaks.at(-1);if(!target||n.kind==='ContinueStatement'&&n.label&&!loops.has(target.statement?.kind))refused=true;else{targets.set(n,target);nearest.set(n,breaks.at(-1));if(n.kind==='BreakStatement'&&n.label)jumps.push(n);}}
    children(n,c=>visit(c,n,n.kind==='LabeledStatement'?[...labels,n]:labels,loops.has(n.kind)||n.kind==='SwitchStatement'?[...breaks,n]:breaks,loops.has(n.kind)?[...loopStack,n]:loopStack,depth+1));
  }visit(parsed);if(refused)return unchanged();
  const range=(a,b)=>({start:tokens[a].range.startOffset-2,end:tokens[b].range.endOffset-2});
  function terminalJump(n,target){const i=starts.get(n?.range?.startOffset);return n?.kind==='BreakStatement'&&!n.label&&targets.get(n)===target&&tokens[i]?.text==='break'&&tokens[i+1]?.text===';';}
  const edits=[],selections=[],selectedJumps=new Set();
  for(const jump of jumps){const frame=targets.get(jump),near=nearest.get(jump);if(frame?.kind!=='LabeledStatement'||frame.statement?.kind!=='BlockStatement'||near?.kind!=='SwitchStatement')continue;
    let cursor=near,valid=true,corridor=[];
    while(cursor!==frame.statement){const parent=parents.get(cursor);if(!parent){valid=false;break;}
      if(parent.kind==='BlockStatement'){if(parent.statements.at(-1)!==cursor){valid=false;break;}}
      else if(parent.kind==='IfStatement'){if(![parent.consequent,parent.alternate].includes(cursor)){valid=false;break;}}
      else if(parent.kind==='LabeledStatement'){if(parent.statement!==cursor||cursor.kind!=='BlockStatement'){valid=false;break;}}
      else if(parent.kind==='SwitchBlockStatementGroup'){
        const outer=parents.get(parent),index=parent.statements.indexOf(cursor),rest=parent.statements.slice(index+1);
        if(outer?.kind!=='SwitchStatement'||index<0||outer.groups.some(g=>g.labels.some(l=>l.separator!==':'))){valid=false;break;}
        if(rest.length===1&&terminalJump(rest[0],outer))corridor.push({kind:'enclosing-switch-break',range:range(starts.get(rest[0].range.startOffset),starts.get(rest[0].range.startOffset)+1)});
        else if(rest.length||outer.groups.at(-1)!==parent){valid=false;break;}
        else corridor.push({kind:'final-case-fallthrough'});
        cursor=outer;continue;
      }else{valid=false;break;}
      corridor.push({kind:parent.kind});cursor=parent;
    }
    if(!valid||!corridor.some(c=>['enclosing-switch-break','final-case-fallthrough'].includes(c.kind)))continue;
    const first=starts.get(jump.range?.startOffset),sw=starts.get(near.range?.startOffset),swEnd=closes.get(closes.get(sw+1)+1),label=starts.get(frame.range?.startOffset),frameOpen=starts.get(frame.statement.range?.startOffset),frameEnd=closes.get(frameOpen);
    if(tokens[first]?.text!=='break'||tokens[first+1]?.text!==jump.label||tokens[first+2]?.text!==';'||tokens[sw]?.text!=='switch'||tokens[swEnd]?.text!=='}'||tokens[label]?.text!==frame.label||tokens[frameEnd]?.text!=='}')continue;
    const edit={start:tokens[first].range.endOffset-2,end:tokens[first+1].range.endOffset-2,text:''};edits.push(edit);selectedJumps.add(jump);selections.push({jumpRange:range(first,first+2),frameRange:range(label,frameEnd),switchRange:range(sw,swEnd),label:frame.label,corridor});
  }
  if(!edits.length)return unchanged();const removedFrames=[];for(const frame of new Set([...selectedJumps].map(j=>targets.get(j)))){if(jumps.some(j=>targets.get(j)===frame&&!selectedJumps.has(j)))continue;const first=starts.get(frame.range.startOffset);if(tokens[first]?.text!==frame.label||tokens[first+1]?.text!==':')return unchanged();const r=range(first,first+1);edits.push({...r,text:''});removedFrames.push({label:frame.label,range:r});}edits.sort((a,b)=>b.start-a.start);let result=source;for(const e of edits)result=result.slice(0,e.start)+result.slice(e.end);
  return{source:result,breaksLocalized:selections.length,labelsRemoved:removedFrames.length,...(retainDiagnostics?{diagnostics:{edits,selections,removedFrames}}:{})};
}
module.exports={foldSharedSwitchFrameExits};
