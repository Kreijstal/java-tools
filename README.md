# Java Classfile Parser

This project provides tools for parsing and analyzing Java `.class` files. It uses the `jvm_parser` library to create an Abstract Syntax Tree (AST) from bytecode, allowing for in-depth analysis of Java classes.

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
