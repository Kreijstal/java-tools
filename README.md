# Java Classfile Parser

This project provides tools for parsing and analyzing Java `.class` files. It uses the `jvm_parser` library to create an Abstract Syntax Tree (AST) from bytecode, allowing for in-depth analysis of Java classes.

## New Features 🔥

### JVM Debug API and State Serialization
The project now includes comprehensive debugging and serialization capabilities:

- **🔍 Debug API**: Step-by-step execution control (step into, over, out, instruction, finish)
- **💾 State Serialization**: Pause and resume JVM execution across different Node.js runtimes
- **🎯 Breakpoints**: Set/clear breakpoints at any program counter location
- **📊 State Inspection**: Real-time access to stack, locals, call depth, and program counter
- **🌐 Web Integration**: Ready for web application debugging interfaces

```bash
# Try the debug demo
node scripts/debugDemo.js

# See the web interface demo
open examples/debug-web-interface.html
```

For detailed documentation, see [DEBUG_API.md](DEBUG_API.md).

## How to Use

To parse a Java `.class` file, you can use the `runLoadAndTraverse.js` script. This script takes a class name and an optional classpath as arguments.

**Usage:**
```bash
node scripts/runLoadAndTraverse.js <className> [classPath]
```

The `className` is the name of the class to parse (e.g., `Hello`), and `classPath` is the directory where the `.class` file is located (e.g., `sources`). If `classPath` is not provided, it defaults to the current directory.

**Example:**

First, compile the Java source file:
```bash
javac sources/Hello.java
```

Then, run the script:
```bash
node scripts/runLoadAndTraverse.js Hello sources
```

This will parse the `Hello.class` file from the `sources` directory and print information about the loaded classes.

## How it is related to Krakatau

This project is not directly related to the Krakatau decompiler. While both tools work with Java bytecode, they serve different purposes. Krakatau is a decompiler and disassembler that attempts to reconstruct Java source code from bytecode. This project, on the other hand, provides a library for parsing `.class` files into an AST, which can then be used for various analysis tasks.

## How to Parse a Class

You can parse a `.class` file by using the `loadAndTraverse` function from `src/loadAndTraverse.js`. This function takes a class name and a classpath as arguments. It returns an object containing the Abstract Syntax Tree (AST) and a reference object.

The `parseHelloClass.js` script provides an example of how to parse a class and traverse its AST to find class references.

## Installation

To install the dependencies, run:

```bash
npm install
```

### Development Setup

This project requires both Node.js and Java environments:
- **Node.js** (v18.x or v20.x)
- **Java JDK** (v11 or v17)

For local development, you can use the provided Makefile:

```bash
make install  # Install dependencies
make build    # Compile Java sources
make test     # Run tests
make clean    # Clean compiled files
```

Or use npm scripts directly:

```bash
npm run build:java  # Compile Java sources
npm test           # Run test suite
npm run clean      # Remove compiled files
```

## Continuous Integration

This project includes GitHub Actions CI that automatically:
- Tests against multiple Node.js (18.x, 20.x) and Java (11, 17) versions
- Compiles Java sources and runs the complete test suite
- Provides build artifacts for debugging

See [CI.md](CI.md) for detailed CI configuration information.

## Utilities

This project also includes several utility scripts for manipulating Java class files.

### `renameMethod.js`

This script allows you to rename a method within a class. It takes the class name, the old method name, and the new method name as arguments. The script will update all references to the old method name to the new one.

### `replaceMethod.js`

This script replaces a method in a class with another method. It effectively renames a method, but is designed to be used in a way that it replaces a method implementation with another.

**Usage:**

```bash
node src/replaceMethod.js <mainClass> <className> <classPath> <oldMethodName> <newMethodName> <targetPath>
```

### `showAST.js`

This script prints the complete Abstract Syntax Tree (AST) of a given `.class` file.

**Usage:**

```bash
node scripts/showAST.js <classFilePath>
```

### `runJvm.js`

This script executes a `.class` file using a basic, custom-built JVM.

**Usage:**

```bash
node scripts/runJvm.js <classFilePath>


## Supported Java Bytecode Instructions

The JVM implementation currently supports a comprehensive set of Java bytecode instructions:

### Integer Constants
- `iconst_m1`, `iconst_0`, `iconst_1`, `iconst_2`, `iconst_3`, `iconst_4`, `iconst_5` - Load integer constants
- `ldc` - Load constants from constant pool

### Local Variable Operations  
- `iload_0`, `iload_1`, `iload_2`, `iload_3` - Load integers from local variables
- `istore_0`, `istore_1`, `istore_2`, `istore_3` - Store integers to local variables
- `aload_0`, `aload_1`, `aload_2`, `aload_3` - Load object references from local variables
- `astore_0`, `astore_1`, `astore_2`, `astore_3` - Store object references to local variables
- `aload`, `astore` - Load/store object references from/to any local variable index

### Arithmetic Operations
- `iadd` - Integer addition
- `isub` - Integer subtraction  
- `imul` - Integer multiplication
- `idiv` - Integer division
- `irem` - Integer remainder (modulo)

### Stack Operations
- `dup` - Duplicate top stack value
- `pop` - Remove top stack value

### Method Invocation
- `invokestatic` - Invoke static methods
- `invokevirtual` - Invoke virtual methods (including System.out.println and String.concat)
- `invokespecial` - Invoke constructors and private methods

### Field Access
- `getstatic` - Get static field values

### Control Flow
- `return` - Return from void method
- `ireturn` - Return integer value from method

### Examples

The following Java programs are included as test cases:

- **RuntimeArithmetic.java** - Demonstrates all arithmetic operations
- **SmallDivisionTest.java** - Shows integer division and remainder
- **ConstantsTest.java** - Tests all integer constant instructions
- **Calculator.java** - Static method calls with parameters
- **SimpleStringConcat.java** - Simple string concatenation (compile-time optimized)
- **StringConcatMethod.java** - String concatenation using String.concat() method calls

### String Concatenation Support

The JVM supports string concatenation through multiple approaches:

1. **Compile-time optimized concatenation**: When string literals are concatenated directly (e.g., `"Hello" + " " + "World"`), the Java compiler optimizes this into a single string constant.

2. **String.concat() method calls**: For runtime string concatenation, the JVM supports calling the `String.concat()` method on string objects.

**Example usage:**
```java
public class StringConcatMethod {
    public static void main(String[] args) {
        String hello = "Hello";
        String space = " ";
        String world = "World";
        String result = hello.concat(space).concat(world);
        System.out.println(result); // Prints: Hello World
    }
}
```

**Note**: Modern Java (9+) uses `invokedynamic` instructions for the `+` operator on variables, which this JVM does not currently support. Use explicit `String.concat()` calls for variable concatenation.
