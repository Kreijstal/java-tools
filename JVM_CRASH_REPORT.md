# JVM Crash and Failure Test Results

This document summarizes Java programs that cause the custom JVM to crash or behave incorrectly compared to the standard Java Virtual Machine.

## Summary of Issues Found

### 1. Missing/Unimplemented Bytecode Instructions

#### CRITICAL CRASHES:
1. **`newarray`** - Array creation instruction is completely missing
   - **Test**: `SimpleArrayTest.java`, `ArrayTest.java`
   - **Java Code**: `int[] arr = new int[5];`
   - **Error**: `Unknown or unimplemented instruction: newarray`
   - **Impact**: Cannot create any arrays (primitive or object arrays)

2. **`sipush`** - Short integer push instruction is missing 
   - **Test**: `SipushTest.java`, `BoxingUnboxingTest.java`, `ObjectCreationTest.java`
   - **Java Code**: Any integer constant > 127 (e.g., `int x = 200;`)
   - **Error**: `Unknown or unimplemented instruction: sipush`
   - **Impact**: Cannot use integer constants outside -128 to 127 range

3. **`getstatic`** - Static field access is partially implemented
   - **Test**: `StaticFieldTest.java`, `EnumTest.java`, `SynchronizationTest.java`
   - **Java Code**: `staticField` or enum constants like `Color.RED`
   - **Error**: `Unsupported getstatic: ClassName.fieldName`
   - **Impact**: Cannot access static fields or enum constants

### 2. Null Pointer Handling Issues

4. **Null invokevirtual** - Improper null checking in method invocation
   - **Test**: `NullPointerTest.java`
   - **Java Code**: `String str = null; str.length();`
   - **Error**: `Cannot read properties of null (reading 'type')`
   - **Impact**: JVM crashes instead of throwing proper NullPointerException

### 3. Boxing/Unboxing Problems

5. **Autoboxing Display** - Boxed objects show as `[object Object]`
   - **Test**: `BoxingUnboxingTest.java`
   - **Java Code**: `Integer i = 42; System.out.println(i);`
   - **Expected**: `42`
   - **Actual**: `[object Object]`
   - **Impact**: Incorrect toString() behavior for wrapper classes

### 4. Exception Handling Issues

6. **Missing Exception Classes** - Standard exception classes not available
   - **Test**: `TryCatchTest.java`
   - **Error**: `Class file not found: sources/java/lang/ArithmeticException.class`
   - **Impact**: Exception handling works partially but lacks standard exception types

7. **Exception Method Calls** - Exception methods not implemented
   - **Test**: `TryCatchTest.java`
   - **Error**: `Unsupported invokevirtual: java/lang/ArithmeticException.getMessage()`
   - **Impact**: Cannot call methods on exception objects

### 5. Complex Class Dependencies

8. **JRE Dependencies** - Missing core JRE classes
   - **Test**: `InnerClassTest.java`
   - **Error**: `Class file not found: sources/java/util/Objects.class`
   - **Impact**: Cannot use advanced language features that depend on core JRE classes

## Working Features

### ✅ Successfully Implemented:
1. **Basic arithmetic operations** (iadd, isub, imul, idiv, irem)
2. **String operations and concatenation**
3. **Method invocation** (invokevirtual, invokestatic) - basic cases
4. **Lambda expressions and invokedynamic**
5. **Simple recursion** without static variables
6. **Object creation and instance methods** - basic cases
7. **System.out.println** with simple types
8. **Basic exception handling structure** (try/catch/finally blocks work)

### ⚠️ Partially Working:
1. **Exception handling** - structure works, but standard exceptions missing
2. **Static field access** - some cases work, others crash
3. **Object creation** - works until hitting missing instructions

## Test Programs Created

### Crash-Inducing Programs:
- `SimpleArrayTest.java` - Crashes on `newarray`
- `ArrayTest.java` - Complex array operations (crashes immediately on newarray)
- `StaticFieldTest.java` - Crashes on `getstatic`
- `BoxingUnboxingTest.java` - Crashes on `sipush`, wrong boxing display
- `InstanceofTest.java` - Crashes on `newarray` (for int[] creation)
- `SynchronizationTest.java` - Crashes on `getstatic`
- `EnumTest.java` - Crashes on `getstatic` for enum constants
- `SipushTest.java` - Crashes on `sipush`
- `TryCatchTest.java` - Partial failure on exception method calls
- `CheckCastTest.java` - (not tested due to earlier crashes)
- `NullPointerTest.java` - JVM crashes instead of proper NPE
- `StackOverflowTest.java` - Crashes on `getstatic` before testing overflow
- `InnerClassTest.java` - Missing JRE dependencies

### Successfully Working Programs:
- `RecursionTest.java` - Factorial calculation works perfectly
- `Hello.java` - Basic string printing works
- `RuntimeArithmetic.java` - Basic arithmetic operations work
- Various simple programs from existing test suite

## Recommendations for Fixing

### Priority 1 (Critical - Basic Language Features):
1. Implement `newarray` instruction for array creation
2. Implement `sipush` instruction for short integer constants
3. Complete `getstatic`/`putstatic` implementation for static fields

### Priority 2 (Error Handling):
4. Fix null pointer handling in `invokevirtual`
5. Implement proper NullPointerException throwing
6. Add basic exception classes (ArithmeticException, NullPointerException, etc.)

### Priority 3 (Feature Completeness):
7. Fix boxing/unboxing display issues
8. Add more JRE core classes for advanced features
9. Implement remaining bytecode instructions as needed

### Priority 4 (Advanced Features):
10. Add instanceof and checkcast instructions
11. Implement synchronized method/block support
12. Add enum and inner class support

These test programs provide a systematic way to identify missing JVM features and can be used to verify fixes as they are implemented.