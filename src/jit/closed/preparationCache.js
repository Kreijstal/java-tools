'use strict';
const {digest}=require('./cacheDigest');
const {uleb}=require('./wasmBuilder');
const FORMAT='closed-world-preparation/1';
const SECTION='jvm.closed.preparation';
const MAX_ENTRY=16*1024*1024, MAX_TOTAL=64*1024*1024, MAX_ENTRIES=8;
const MAX_METADATA=32*1024*1024;
const encode=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?{$bigint:String(v)}:
  typeof v==='number'&&!Number.isFinite(v)?{$number:String(v)}:Object.is(v,-0)?{$number:'-0'}:v);
const recordKeys=['key','className','isStatic','paramKinds','paramDescriptors','paramReprs','returnKind','returnRepr',
  'synchronized','lockGlobal','recursive','exportName'];
let browserBackend;

// One bounded origin-local store. The WebAssembly Web API forbids Module
// serialization for storage, so persist final bytes and symbolic metadata.
function browserCache() {
  let factory;
  try{factory=globalThis.indexedDB;}catch{return null;}
  if(!factory)return null;
  if(browserBackend)return browserBackend;
  let opened;
  const open=()=>opened||=(new Promise((resolve,reject)=>{
    const request=factory.open('jvm-closed-preparation',1);
    request.onupgradeneeded=()=>{
      const store=request.result.createObjectStore('artifacts',{keyPath:'key'});
      store.createIndex('evict',['written','size']);store.createIndex('size','size');
    };
    request.onerror=()=>{opened=null;reject(request.error);};
    request.onblocked=()=>{opened=null;reject(new Error('Preparation cache blocked'));};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opened=null;};resolve(db);};
  }));
  const put=async value=>{
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('artifacts','readwrite'),store=tx.objectStore('artifacts');
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Preparation cache write aborted'));
      store.put(value);
      // Read only indexed metadata, never clone old Modules to evict them.
      let size=0,count=0;
      const sizes=store.index('size').openKeyCursor();
      sizes.onsuccess=()=>{
        const cursor=sizes.result;
        if(cursor){size+=cursor.key;count++;cursor.continue();return;}
        if(size<=MAX_TOTAL&&count<=MAX_ENTRIES)return;
        const oldest=store.index('evict').openKeyCursor();
        oldest.onsuccess=()=>{
          const row=oldest.result;if(!row||size<=MAX_TOTAL&&count<=MAX_ENTRIES)return;
          size-=row.key[1];count--;store.delete(row.primaryKey);row.continue();
        };
      };
    });
  };
  browserBackend={
    async get(key){const db=await open();return new Promise((resolve,reject)=>{
      const request=db.transaction('artifacts','readonly').objectStore('artifacts').get(key);
      request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);
    });},
    async delete(key){const db=await open();return new Promise((resolve,reject)=>{
      const tx=db.transaction('artifacts','readwrite');tx.objectStore('artifacts').delete(key);
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);
    });},
    async put(entry){
      const {module,...artifact}=entry;
      await put({...artifact,written:Date.now()});
      return {nativeModule:false};
    },
  };
  return browserBackend;
}

function fingerprint(world) {
  const jvm=world.jvm;
  const classes=Object.entries(jvm.classes).map(([name,data])=>{
    const ast=world.classAst(name);
    return [name,!!data.isJreStub,!data.isJreStub&&ast&&{super:ast.superClassName,interfaces:ast.interfaces,flags:ast.flags,
      items:ast.items.map(item=>item.type==='method'?{method:{name:item.method.name,descriptor:item.method.descriptor,
        flags:item.method.flags,attributes:item.method.attributes}}:item.type==='field'?{field:item.field}:null)},data.constantPool];
  });
  const natives=Object.keys(jvm.jre||{}).sort().map(name=>{
    const spec=jvm.jre[name];return [name,spec.super,spec.interfaces,spec.applicationFallback,
      spec.staticFieldDeclarations,Object.keys(spec.staticFields||{}).sort(),
      ...['methods','staticMethods'].map(kind=>Object.entries(spec[kind]||{}).sort(([a],[b])=>a.localeCompare(b))
        .map(([key,fn])=>[key,typeof fn==='function'?Function.prototype.toString.call(fn):typeof fn]))];
  });
  const layouts=[...world.classTypes.values()].map(t=>[t.name,t.index,t.parent?.name,t.layout.classId,t.layout.size,t.layout.slots,t.layout.references]);
  return encode({format:FORMAT,runtime:world.cacheIdentity,classes,natives,layouts,indices:[...jvm._classIndices],
    jspi:world.jspi,optimisticAsync:world.optimisticAsync,maxStackDepth:jvm.maxStackDepth||1024,
    dense:jvm.denseInstanceFields,heapPages:world.runtime.heap.memory.buffer.byteLength>>>16,
    heapAllocated:world.runtime.heap.usage().allocated,overrides:[...(jvm.jreOverridden||[])].sort()});
}

function marker(entry){return `${entry.key}:${entry.metadataHash}:${entry.bytesHash}`;}
async function metadataBytes(metadata) {
  const bytes=new TextEncoder().encode(encode(metadata));
  if(bytes.length>MAX_METADATA)throw new Error('Preparation binding metadata exceeds budget');
  if(bytes.length<65536||typeof CompressionStream!=='function')return {bytes,encoding:'json'};
  return {bytes:new Uint8Array(await new Response(new Blob([bytes]).stream()
    .pipeThrough(new CompressionStream('gzip'))).arrayBuffer()),encoding:'gzip'};
}
async function decodeMetadata(entry) {
  let bytes=entry.metadataBytes;
  if(entry.metadataEncoding==='gzip') {
    const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    let size=0;const chunks=[];
    try {
      for(;;) {
        const {done,value}=await reader.read();if(done)break;
        size+=value.length;if(size>MAX_METADATA)throw new Error('Preparation binding metadata exceeds budget');
        chunks.push(value);
      }
    }catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
    bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  }else if(entry.metadataEncoding!=='json')throw new Error('Unknown preparation metadata encoding');
  if(bytes.length>MAX_METADATA)throw new Error('Preparation binding metadata exceeds budget');
  return JSON.parse(new TextDecoder().decode(bytes));
}
function markedBytes(entry) {
  const name=new TextEncoder().encode(SECTION),value=new TextEncoder().encode(marker(entry));
  const payload=Uint8Array.from([...uleb(name.length),...name,...value]);
  const header=Uint8Array.from([0,...uleb(payload.length)]);
  const out=new Uint8Array(entry.bytes.length+header.length+payload.length);
  out.set(entry.bytes);out.set(header,entry.bytes.length);out.set(payload,entry.bytes.length+header.length);return out;
}

function restoreImport(world,spec) {
  const {key,params,results,binding:b}=spec;
  if(key.startsWith('h:'))return world.hostImport(key.slice(2),params,results);
  if(key.startsWith('park:'))return world.parkImport(key.slice(5));
  if(!b)throw new Error('No symbolic binding for '+key);
  switch(b.kind) {
    case 'exception':return world.exceptionTypeImport(b.type);
    case 'allocation':return world.allocationImport(b.allocation,b.name,b.dims);
    case 'math':return world.pureImport(key,params,results,Math[b.name],b);
    case 'native':{
      const method=key.slice(7),dot=method.indexOf('.'),paren=method.indexOf('(');
      const owner=method.slice(0,dot),name=method.slice(dot+1,paren);
      const native=world.jvm._jreFindMethod(owner,name,b.descriptor);
      if(typeof native!=='function')throw new Error('Cached native binding missing: '+key);
      return world.nativeImport(key,native,b.descriptor,b.hasReceiver);
    }
    case 'virtual-host':return world.virtualHostImport(b.owner,b.name,b.descriptor,b.argKinds,b.returnKind,b.siteId,b.fallback);
    case 'bytecode-invoke':return world.bytecodeInvokeImport(b.siteId);
    case 'instanceof':return world.instanceOfImport(b.target);
    case 'throw':return world.throwingImport(key,params,results,b.type,b.message);
    case 'spill-field':return world.primitiveSpillFieldImport(b.op,{key:b.key},b.valueKind);
    case 'spill-array':return require('./primitiveSpillArray').primitiveSpillArrayImport(world,b.op,b.valueKind);
    case 'host-field':return world.hostFieldPlan(b.op,b.imm,b.valueKind).fn;
    case 'slow-call':return world.slowCallImport(world.signatureOf(b.key));
    default:throw new Error('Unknown cached binding kind: '+b.kind);
  }
}

// NPE diagnostics refer to the already-loaded method's code. Serializing that
// array at every protected invoke duplicates whole methods thousands of times.
// Keep a method/item reference, then bind it to the fresh class data on replay.
function captureSites(world) {
  const methods=new Map([...world.entries.values()].map(r=>[
    r.method.attributes?.find(a=>a.type==='code')?.code?.codeItems,r.key]));
  return world.sites.map(site=>{
    if(!site.npe)return site;
    const {items,item,owner,name}=site.npe,methodKey=methods.get(items),itemIndex=items.indexOf(item);
    if(!methodKey||itemIndex<0)throw new Error('Unbound exception diagnostic site');
    return {...site,npe:{methodKey,itemIndex,owner,name}};
  });
}
function restoreSites(sites,methods) {
  return sites.map(site=>{
    if(!site.npe)return site;
    const {methodKey,itemIndex,owner,name}=site.npe;
    const items=methods.get(methodKey)?.attributes?.find(a=>a.type==='code')?.code?.codeItems;
    if(!items?.[itemIndex])throw new Error('Cached exception diagnostic site changed');
    return {...site,npe:{items,item:items[itemIndex],owner,name}};
  });
}

async function restore(world,methods,thread) {
  if(!world.cacheIdentity||!world.preparationCache){world.cacheStatus={status:'unavailable'};return false;}
  world.reportPreparation('closed-cache-check');
  try {
    world.cacheKey=await digest(fingerprint(world));
    const entry=await world.preparationCache.get(world.cacheKey);
    world.cacheStatus={status:'miss',key:world.cacheKey};
    if(!entry)return false;
    if(entry.format!==FORMAT||entry.key!==world.cacheKey||!(entry.bytes instanceof Uint8Array)||
      !(entry.metadataBytes instanceof Uint8Array)||entry.bytes.length+entry.metadataBytes.length>MAX_ENTRY||
      await digest(entry.metadataBytes)!==entry.metadataHash||await digest(entry.bytes)!==entry.bytesHash)
      throw new Error('Invalid preparation cache receipt');
    const meta=await decodeMetadata(entry);
    for(const [name,id] of meta.indices)if(world.classId(name)!==id)throw new Error('Cached class ID changed');
    const byKey=new Map(methods.map(row=>[row.key,row.method]));
    for(const r of meta.entries) {
      const method=byKey.get(r.key);if(!method)throw new Error('Cached method missing: '+r.key);
      world.entries.set(r.key,{...r,method,calls:new Set(r.calls),initClasses:new Set(r.initClasses)});
    }
    world.rejected=new Map(meta.rejected);world.sites=restoreSites(meta.sites,byKey);world.knownClassLimit=meta.knownClassLimit;
    for(const event of meta.events) {
      if(event.kind==='init') {
        const target=world.initTarget(event.className);
        if(target.id!==event.id||target.address!==event.address)throw new Error('Cached initialization address changed');
      }else if(event.kind==='global') {
        const b=event.binding;
        const value=b?.kind==='string'?world.jvm.internString(b.value):b?.kind==='class'?world.jvm.getClassObjectSync(b.name):undefined;
        if(value===undefined||value===null)throw new Error('Cached constant binding unavailable');
        world.globalImport(event.key,event.valtype,event.mutable,value,b);
      }else if(event.kind==='static') {
        const b=event.binding;if(!b)throw new Error('Cached static field has no binding');
        const store=world.staticStore(b.owner),cell=store?.cell?.(`${b.name}:${b.descriptor}`);
        if(!cell?.closedGlobal)throw new Error('Cached static storage unavailable');
        world.staticGlobal(event.key,event.valtype,cell,b);
      }else throw new Error('Unknown preparation binding event');
    }
    for(const [key,exportName]of meta.staticExports)world.staticGlobals.get(key).exportName=exportName;
    for(const spec of meta.imports) {
      const key=restoreImport(world,spec),actual=world.imports.get(key);
      if(key!==spec.key||encode(actual.params)!==encode(spec.params)||encode(actual.results)!==encode(spec.results)||
        !!actual.suspending!==!!spec.suspending||!!actual.pure!==!!spec.pure)throw new Error('Cached import signature changed: '+spec.key);
    }
    const imports={c:{mem:world.runtime.heap.memory},t:{jx:world.tag},s:{},f:{}};
    let i=0;
    for(const spec of meta.globalImports) {
      const g=world.globalImports.get(spec.key);if(!g)throw new Error('Cached global missing');
      imports.s['g'+i++]=g.mutable?g.value:new WebAssembly.Global({value:'externref',mutable:false},g.value);
    }
    i=0;
    for(const spec of meta.imports) {
      const imp=world.imports.get(spec.key);
      imports.f['f'+i++]=imp.suspending?new WebAssembly.Suspending(imp.impl):imp.pure?imp.impl:world.wrapHost(imp.impl,imp.params.length);
    }
    let module=entry.module;
    const nativeModule=module instanceof WebAssembly.Module;
    if(nativeModule) {
      const sections=WebAssembly.Module.customSections(module,SECTION);
      if(sections.length!==1||new TextDecoder().decode(sections[0])!==marker(entry))throw new Error('Cached module receipt mismatch');
    }else module=await WebAssembly.compile(markedBytes(entry));
    const instance=await WebAssembly.instantiate(module,imports);
    for(const r of world.entries.values())if(typeof instance.exports[r.exportName]!=='function')throw new Error('Cached export missing');
    world.installInstance(instance);world.moduleBytes=markedBytes(entry).length;
    world.counters.recursive=meta.recursive;world.counters.stubs=meta.stubs;
    world.optimisticAsyncSites=meta.optimisticAsyncSites;
    world.cacheStatus={status:'hit',key:world.cacheKey,nativeModule,bytes:entry.size};
    world.reportPreparation('closed-cache-hit',1,1);

  }catch(error) {
    world.cacheStatus={status:'rejected',key:world.cacheKey,reason:String(error?.message||error)};
    try{await world.preparationCache.delete?.(world.cacheKey);}catch{}
    world.cacheKey=null;
    world.entries.clear();world.entryByMethod.clear();world.imports.clear();world.globalImports.clear();
    world.staticGlobals=new Map();world.initTargets=new Map();world.sites=[];world.bindingEvents=[];
    world.stubSignatures=new Map();world.rejected.clear();
    world.reportPreparation('closed-cache-rejected');
    return false;
  }
  // Guest initialization failures must propagate just as on a cold build.
  if(thread)await world.initializeTrivialClasses(thread);
  return true;
}

async function capture(world,bytes) {
  if(!world.cacheKey||!world.preparationCache)return null;
  try {
    const imports=[...world.imports].map(([key,imp])=>({key,params:imp.params,results:imp.results,
      pure:!!imp.pure,suspending:!!imp.suspending,binding:imp.binding}));
    if(imports.some(i=>!i.binding&&!i.key.startsWith('h:')&&!i.key.startsWith('park:')))
      throw new Error('A host import has no serializable binding');
    const metadata={
      entries:[...world.entries.values()].map(r=>({...Object.fromEntries(recordKeys.map(k=>[k,r[k]])),calls:[...r.calls],initClasses:[...r.initClasses]})),
      events:world.bindingEvents,imports,globalImports:[...world.globalImports.keys()].map(key=>({key})),
      staticExports:[...(world.staticGlobals||[])].map(([key,g])=>[key,g.exportName]),
      indices:[...world.jvm._classIndices],sites:captureSites(world),rejected:[...world.rejected],knownClassLimit:world.knownClassLimit,
      recursive:world.counters.recursive||0,stubs:world.counters.stubs||0,optimisticAsyncSites:world.optimisticAsyncSites||0,
    };
    const packed=await metadataBytes(metadata),size=bytes.length+packed.bytes.length;
    if(size>MAX_ENTRY)throw new Error('Preparation artifact exceeds cache entry budget');
    return {format:FORMAT,key:world.cacheKey,metadataBytes:packed.bytes,metadataEncoding:packed.encoding,
      bytes:new Uint8Array(bytes),size,metadataHash:await digest(packed.bytes),bytesHash:await digest(bytes)};
  }catch(error){world.cacheStatus={...world.cacheStatus,status:'not-stored',reason:String(error?.message||error)};return null;}
}
async function save(world,entry,module) {
  if(!entry)return;
  try{const saved=await world.preparationCache.put({...entry,module});
    world.cacheStatus={...world.cacheStatus,status:'stored',nativeModule:saved?.nativeModule??true,bytes:entry.size};}
  catch(error){world.cacheStatus={...world.cacheStatus,status:'write-failed',reason:String(error?.message||error)};}
}
module.exports={browserCache,restore,capture,save,markedBytes,fingerprint,FORMAT};
