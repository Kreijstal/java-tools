'use strict';

// A plain frame followed only by the loop's final break shares the loop's exit.
// Put its existing name on the loop (or merge into an existing loop name), so
// deeply nested exits remain explicit without an extra block/frame level.
function foldTerminalLoopFrames(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed,tokens,starts,closes,children,labelCounts} = proof;
  if(labelCounts.size>256||[...labelCounts.values()].some(count=>count!==1))return unchanged();
  const loopKinds=new Set(['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement']);
  const parents=new Map(),targets=new Map(),refs=new Map(),candidates=[];let refused=false;
  function walk(node,parent=null,labels=[],breaks=[],loops=[],depth=0){
    if(depth>128){refused=true;return;}parents.set(node,parent);
    if(/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind||'')||node.kind==='NewClassExpression'&&node.body!=null)refused=true;
    if(loopKinds.has(node.kind))candidates.push(node);
    if(['BreakStatement','ContinueStatement'].includes(node.kind)){
      const target=node.label?labels.slice().reverse().find(frame=>frame.label===node.label):node.kind==='ContinueStatement'?loops.at(-1):breaks.at(-1);
      const first=starts.get(node.range?.startOffset),end=first+(node.label?2:1);
      if(!target||node.kind==='ContinueStatement'&&!loopKinds.has(target.kind)&&!loopKinds.has(target.statement?.kind)||tokens[first]?.text!==(node.kind==='BreakStatement'?'break':'continue')||tokens[end]?.text!==';'||node.label&&tokens[first+1]?.text!==node.label)refused=true;
      else{targets.set(node,target);refs.set(target,[...(refs.get(target)||[]),node]);}
    }
    children(node,child=>walk(child,node,node.kind==='LabeledStatement'?[...labels,node]:labels,loopKinds.has(node.kind)||node.kind==='SwitchStatement'?[...breaks,node]:breaks,loopKinds.has(node.kind)?[...loops,node]:loops,depth+1));
  }
  walk(parsed);if(refused)return unchanged();
  const range=(a,b)=>({start:tokens[a].range.startOffset-2,end:tokens[b].range.endOffset-2});
  const bounds=node=>{const open=starts.get(node?.range?.startOffset),close=closes.get(open);return node?.kind==='BlockStatement'&&tokens[open]?.text==='{'&&tokens[close]?.text==='}'?{open,close}:null;};
  for(const loop of candidates){
    const body=bounds(loop.body),statements=loop.body?.statements,frame=statements?.at(-2),exit=statements?.at(-1),frameBody=bounds(frame?.statement);
    const references=refs.get(frame),first=starts.get(loop.range?.startOffset),label=starts.get(frame?.range?.startOffset),exitFirst=starts.get(exit?.range?.startOffset);
    if(!body||!frameBody||!frame.statement.statements.length||frame?.kind!=='LabeledStatement'||exit?.kind!=='BreakStatement'||exit.label||targets.get(exit)!==loop||!references?.length||references.length>128||references.some(jump=>jump.kind!=='BreakStatement')
        ||tokens[label]?.text!==frame.label||tokens[label+1]?.text!==':'||label+2!==frameBody.open||tokens[exitFirst]?.text!=='break'||tokens[exitFirst+1]?.text!==';'||exitFirst!==frameBody.close+1||exitFirst+2!==body.close)continue;
    const outerLabel=parents.get(loop)?.kind==='LabeledStatement'?parents.get(loop):null,targetName=outerLabel?.label||frame.label;
    let last=body.close;if(loop.kind==='DoWhileStatement'){const conditionClose=closes.get(body.close+2);if(tokens[body.close+1]?.text!=='while'||tokens[body.close+2]?.text!=='('||tokens[conditionClose+1]?.text!==';')continue;last=conditionClose+1;}
    if(first===undefined||tokens[last]?.range.endOffset-tokens[first].range.startOffset>40000)continue;
    const keepScope=frame.statement.statements.some(statement=>statement.kind==='LocalVariableDeclarationStatement');
    const frameRange=range(label,frameBody.close),bodyRange=range(frameBody.open,frameBody.close),loopRange=range(first,last),labelRange=range(label,label+1),transfers=[];
    let replacement=source.slice(keepScope?bodyRange.start:tokens[starts.get(frame.statement.statements[0]?.range?.startOffset)].range.startOffset-2,keepScope?bodyRange.end:tokens[frameBody.close].range.startOffset-2);
    let contentRange=keepScope?bodyRange:{start:tokens[starts.get(frame.statement.statements[0]?.range?.startOffset)].range.startOffset-2,end:tokens[frameBody.close-1].range.endOffset-2};
    if(!frame.statement.statements.length)continue;
    const edits=[];
    for(const jump of references){const start=starts.get(jump.range.startOffset);if(tokens[start]?.text!=='break'||tokens[start+1]?.text!==frame.label||tokens[start+2]?.text!==';'){refused=true;break;}const labelTokenRange=range(start+1,start+1);transfers.push({range:range(start,start+2),labelRange:labelTokenRange});if(outerLabel)edits.push({...labelTokenRange,text:targetName});}
    if(refused)return unchanged();
    for(const edit of edits.sort((a,b)=>b.start-a.start))replacement=replacement.slice(0,edit.start-contentRange.start)+edit.text+replacement.slice(edit.end-contentRange.start);
    const indentAt=offset=>{const value=source.slice(source.lastIndexOf('\n',offset-1)+1,offset);return /^[ \t]*$/.test(value)?value:null;};
    let dedent=null;
    if(!keepScope){replacement=replacement.trimEnd();const frameIndent=indentAt(frameRange.start),contentIndent=indentAt(contentRange.start);if(frameIndent!==null&&contentIndent!==null&&contentIndent.startsWith(frameIndent)&&contentIndent.length>frameIndent.length){dedent={indent:contentIndent,delta:contentIndent.length-frameIndent.length};replacement=replacement.split('\n').map((line,index)=>index&&line.startsWith(contentIndent)?line.slice(dedent.delta):line).join('\n');}}
    let loopText=source.slice(loopRange.start,frameRange.start)+replacement+source.slice(frameRange.end,loopRange.end);
    if(!outerLabel)loopText=source.slice(labelRange.start,labelRange.end)+' '+loopText;
    return {source:source.slice(0,loopRange.start)+loopText+source.slice(loopRange.end),framesRecovered:1,
      labelsLifted:Number(!outerLabel),labelsMerged:Number(Boolean(outerLabel)),bodyScopesFlattened:Number(!keepScope),breakTargetsRedirected:references.length,
      ...(retainDiagnostics?{diagnostics:{loopRange,frameRange,bodyRange,contentRange,labelRange,outerLoopKeywordRange:range(first,first),outerBodyRange:range(body.open,body.close),terminalExitRange:range(exitFirst,exitFirst+1),
        frameLabel:frame.label,targetLabel:targetName,outerLabelRange:outerLabel?range(starts.get(outerLabel.range.startOffset),starts.get(outerLabel.range.startOffset)+1):null,keepScope,dedent,transfers}}:{})};
  }
  return unchanged();
}
module.exports={foldTerminalLoopFrames};
