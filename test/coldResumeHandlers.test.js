'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('cold-resume-handlers-');

test('catch, finally, and switch results survive an exception thrown mid-method',async t=>{
 const classpath=fixture(t,'ColdHandlers',`public class ColdHandlers {
  static int cleanups, result;
  static int calculate(int value) {
    try {
      switch(value) { case 0: return 10; case 1: return 100 / (value - 1); default: return 30; }
    } catch (ArithmeticException expected) {
      return "diagnostic-handler-only".length() + 40;
    } finally { cleanups++; }
  }
  public static void main(String[] args) { result = calculate(0)+calculate(1)+calculate(9); }
 }`);
 const j=new JVM({classpath});
 await j.run('ColdHandlers');
 const data=j.classes.ColdHandlers;
 t.equal(data.staticFields.get('result:I'),103,'catch result and normal switch results');
 t.equal(data.staticFields.get('cleanups:I'),3,'finally executes exactly once for every call');
 t.end();
});
