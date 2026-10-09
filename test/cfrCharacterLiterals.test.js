'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {decompileClassFile,_internals:{formatCharLiteral:literal}}=require('../src/decompiler/cfr');
function run(directory,command,args){const files=['stdout','stderr'].map(n=>path.join(directory,n)),fds=files.map(f=>fs.openSync(f,'w'));try{const r=spawnSync(command,args,{stdio:['ignore',...fds]});if(r.error)throw r.error;assert.equal(r.status,0,fs.readFileSync(files[1],'utf8'));return fs.readFileSync(files[0],'utf8').trim();}finally{fds.forEach(fd=>fs.closeSync(fd));}}

test('character controls are visible and surrogates survive UTF-8 serialization',()=>{
 for(const[n,wanted]of [[0,"'\\0'"],[8,"'\\b'"],[9,"'\\t'"],[10,"'\\n'"],[12,"'\\f'"],[13,"'\\r'"],[25,"'\\031'"],[127,"'\\177'"],[159,"'\\237'"],[0xd800,"'\\ud800'"],[0xdfff,"'\\udfff'"],[39,"'\\\''"],[92,"'\\\\'"],[65,"'A'"]])assert.equal(literal(n),wanted);
 for(let n=0;n<65536;n++){const source=literal(n);assert.doesNotMatch(source,/[\x00-\x1f\x7f-\x9f]/);assert.equal(Buffer.from(source,'utf8').toString('utf8'),source);}
});

test('every emitted UTF-16 character literal compiles and matches its numeric oracle',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'java-char-literals-'));
 try{const groups=Array.from({length:256},(_,g)=>`static char[] group${g}(){return new char[]{${Array.from({length:256},(_,i)=>literal(g*256+i)).join(',')}};}`);
 const java=`public class CharacterOracle{${groups.join('\n')}public static void main(String[]args)throws Exception{int count=0;for(int group=0;group<256;group++){char[] values=(char[])CharacterOracle.class.getDeclaredMethod("group"+group).invoke(null);if(values.length!=256)throw new AssertionError();for(int i=0;i<256;i++){if(values[i]!=group*256+i)throw new AssertionError(group+":"+i);count++;}}System.out.println(count);}}`;
 fs.writeFileSync(dir+'/CharacterOracle.java',java,'utf8');run(dir,'javac',['--release','8','-d',dir,dir+'/CharacterOracle.java']);assert.equal(run(dir,'java',['-Xmx128m','-cp',dir,'CharacterOracle']),'65536');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('integer narrowing retains the existing Java char conversion',()=>{
 for(const n of [-2147483648,-65537,-65536,-1,65536,65537,2147483647])assert.equal(literal(n),literal(n&65535));
});

test('decompiled fields, returns, narrow calls and String integer-character calls preserve values',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'java-char-decompile-'));
 try{const before=dir+'/before',after=dir+'/after';fs.mkdirSync(before);fs.mkdirSync(after);
 const source=`@CharMark('\\ud800') public class CharacterCalls{public static final char ZERO='\\0',HIGH='\\ud800',LOW='\\udfff';static int take(char x){return x;}static char upper(){return HIGH;}static char lower(){return LOW;}public static void main(String[]args){if(ZERO!=0||upper()!=55296||lower()!=57343)throw new AssertionError();if(take('\\031')!=25||take('\\237')!=159)throw new AssertionError();if("a".indexOf(0)!=-1||"a".lastIndexOf(0)!=-1)throw new AssertionError();System.out.println("matched");}}`;
 fs.writeFileSync(before+'/CharacterCalls.java',source);fs.writeFileSync(before+'/CharMark.java','@java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) @interface CharMark {char value();}');fs.writeFileSync(before+'/AnnotationOracle.java','public class AnnotationOracle{public static void main(String[]args){CharMark mark=CharacterCalls.class.getAnnotation(CharMark.class);if(mark==null||mark.value()!=55296)throw new AssertionError();System.out.println("matched");}}');run(dir,'javac',['--release','8','-g','-d',before,before+'/CharacterCalls.java',before+'/CharMark.java',before+'/AnnotationOracle.java']);assert.equal(run(dir,'java',['-cp',before,'AnnotationOracle']),'matched');assert.equal(run(dir,'java',['-cp',before,'CharacterCalls']),'matched');const result=decompileClassFile(before+'/CharacterCalls.class',{failOnFallback:true});const text=typeof result==='string'?result:result.source;assert.equal(typeof text,'string');assert.doesNotMatch(text,/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);assert.match(text,/\\ud800/);assert.match(text,/\\udfff/);fs.writeFileSync(after+'/CharacterCalls.java',text);for(const name of ['CharMark.class','AnnotationOracle.class'])fs.copyFileSync(before+'/'+name,after+'/'+name);run(dir,'javac',['--release','8','-classpath',before,'-d',after,after+'/CharacterCalls.java']);assert.equal(run(dir,'java',['-cp',after,'AnnotationOracle']),'matched');assert.equal(run(dir,'java',['-cp',after,'CharacterCalls']),'matched');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
