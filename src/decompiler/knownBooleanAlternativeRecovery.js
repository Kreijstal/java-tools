'use strict';

// A local known true before a decision remains true only on its false arm.
// Reuse that arm directly instead of reading the local again. Keep its original
// declaration, false store, predicate and both complete work blocks in place.
function foldKnownBooleanAlternatives(source, proof, {retainDiagnostics=false,reservedNames=[]}={}) {
  const unchanged=()=>({source,alternativesRecovered:0});
  if(!proof||typeof retainDiagnostics!=='boolean'||!Array.isArray(reservedNames)||reservedNames.some(n=>typeof n!=='string')||source.length>400000)return unchanged();
  const {parsed,tokens,starts,closes,children}=proof,parents=new Map(),declarations=new Map(),blocks=[];
  let refused=false;
  function visit(node,parent=null,depth=0){
    if(depth>128){refused=true;return;}parents.set(node,parent);
    if(/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind||'')||node.kind==='NewClassExpression'&&node.body!=null)refused=true;
    if(node.kind==='VariableDeclarator')declarations.set(node.name,[...(declarations.get(node.name)||[]),node]);
    if(node.kind==='BlockStatement')blocks.push(node);
    children(node,child=>visit(child,node,depth+1));
  }visit(parsed);if(refused)return unchanged();
  const peel=node=>{while(node?.kind==='ParenthesizedExpression')node=node.expression;return node;};
  function writes(node,name){
    let found=false;
    function scan(n){
      if(n.kind==='AssignmentExpression'&&n.left?.kind==='Identifier'&&n.left.name===name||n.kind==='UnaryExpression'&&['++','--'].includes(n.operator)&&n.operand?.kind==='Identifier'&&n.operand.name===name)found=true;
      children(n,scan);
    }scan(node);return found;
  }
  function knownTrue(node,name,local,declaration,scope){
    let cursor=node;
    while(cursor&&cursor!==scope){
      const owner=parents.get(cursor);if(!owner)return null;
      if(owner.kind==='BlockStatement'){
        const index=owner.statements.indexOf(cursor);if(index<0)return null;
        const prefix=owner.statements.slice(0,index),at=prefix.indexOf(declaration);
        if(at>=0){
          const initial=peel(local.initializer);
          if(initial?.kind!=='LiteralExpression'||initial.literalKind!=='boolean'||initial.value!==true||writes(declaration,name)||prefix.slice(at+1).some(s=>writes(s,name)))return null;
          return {kind:'initializer',start:declaration.range.startOffset-2};
        }
        if(prefix.some(s=>writes(s,name)))return null;
      }else if(owner.kind==='IfStatement'){
        if(![owner.consequent,owner.alternate].includes(cursor)||writes(owner.condition,name))return null;
        const condition=peel(owner.condition);
        if(condition?.kind==='Identifier'&&condition.name===name&&owner.consequent===cursor)return {kind:'guard',start:owner.range.startOffset-2};
      }else if(owner.kind==='LabeledStatement'){
        if(owner.statement!==cursor||cursor.kind!=='BlockStatement')return null;
      }else return null; // do not infer true across a loop or protected entry
      cursor=owner;
    }
    return null;
  }
  const range=(a,b)=>({start:tokens[a].range.startOffset-2,end:tokens[b].range.endOffset-2});
  for(const block of blocks.sort((a,b)=>(b.range?.startOffset||0)-(a.range?.startOffset||0)))for(let i=block.statements.length-2;i>=0;i--){
    const first=block.statements[i],second=block.statements[i+1];
    if(first.kind!=='IfStatement'||first.alternate||first.consequent?.kind!=='BlockStatement'||second.kind!=='IfStatement'||second.alternate||second.consequent?.kind!=='BlockStatement')continue;
    const read=peel(second.condition),body=first.consequent,last=body.statements.at(-1),store=last?.expression;
    if(read?.kind!=='Identifier'||reservedNames.includes(read.name)||last?.kind!=='ExpressionStatement'||store?.kind!=='AssignmentExpression'||store.operator!=='='||store.left?.kind!=='Identifier'||store.left.name!==read.name)continue;
    const value=peel(store.right),locals=declarations.get(read.name)||[];
    if(value?.kind!=='LiteralExpression'||value.literalKind!=='boolean'||value.value!==false||locals.length!==1||locals[0].dimensions)continue;
    const local=locals[0],declaration=parents.get(local),scope=parents.get(declaration);
    if(declaration?.kind!=='LocalVariableDeclarationStatement'||declaration.variableType?.kind!=='PrimitiveType'||declaration.variableType.name!=='boolean'||scope?.kind!=='BlockStatement'||declaration.range.startOffset>=first.range.startOffset)continue;
    let lexical=first;while(lexical&&lexical!==scope)lexical=parents.get(lexical);if(lexical!==scope)continue;
    if(writes(first.condition,read.name)||body.statements.slice(0,-1).some(s=>writes(s,read.name)))continue;
    const witness=knownTrue(first,read.name,local,declaration,scope);if(!witness)continue;
    const one=starts.get(first.range?.startOffset),two=starts.get(second.range?.startOffset),open=starts.get(second.consequent.range?.startOffset),close=closes.get(open),trueOpen=starts.get(body.range?.startOffset),trueClose=closes.get(trueOpen);
    if(tokens[one]?.text!=='if'||tokens[two]?.text!=='if'||tokens[open]?.text!=='{'||tokens[close]?.text!=='}'||trueClose+1!==two||close-two>30000)continue;
    const edit={start:tokens[two].range.startOffset-2,end:tokens[open].range.startOffset-2,text:'else '};
    return {source:source.slice(0,edit.start)+edit.text+source.slice(edit.end),alternativesRecovered:1,
      ...(retainDiagnostics?{diagnostics:{name:read.name,firstRange:range(one,trueClose),secondRange:range(two,close),falseBodyRange:range(open,close),witness,edits:[edit]}}:{})};
  }
  return unchanged();
}
module.exports={foldKnownBooleanAlternatives};
