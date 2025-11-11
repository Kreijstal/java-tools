# JVM Tools - Advanced Java Bytecode Analysis & Execution

[![CI](https://github.com/Kreijstal/java-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/Kreijstal/java-tools/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/node.js-18.x%20%7C%2020.x-green.svg)](https://nodejs.org/)
[![Java](https://img.shields.io/badge/java-11%20%7C%2017-orange.svg)](https://adoptopenjdk.net/)

A comprehensive toolkit for Java bytecode analysis, manipulation, and execution. This project provides advanced tools for working with Java `.class` files, including a custom JVM implementation, web-based debugging interface, and extensive bytecode analysis capabilities.

## 🌟 Key Features

### 🔍 Advanced Bytecode Analysis
- **Class File Parsing**: Complete Java class file format support using `jvm_parser`
- **AST Generation**: Convert bytecode to structured Abstract Syntax Trees
- **Method Analysis**: Deep inspection of methods, fields, and class hierarchies
- **Bytecode Manipulation**: Modify and reassemble Java bytecode

### 🚀 Custom JVM Implementation
- **Full Instruction Set**: Comprehensive Java bytecode instruction support
- **Runtime Execution**: Execute Java classes directly in Node.js
- **Multi-threading**: Java threading model implementation
- **Memory Management**: Stack, heap, and garbage collection

### 🐛 Web-Based Debugging
- **Visual Debugger**: Step-by-step execution with web interface
- **Real-Time Inspection**: Examine JVM state, stack, and local variables
- **Breakpoint Management**: Set and manage execution breakpoints
- **State Serialization**: Save and restore JVM execution state

### 🎨 Browser Integration
- **AWT Support**: Run Java GUI applications in browsers
- **Web Assembly**: Java bytecode execution in web environments
- **Cross-Platform**: Same code runs in Node.js and browsers

### 🛠️ Development Tools
- **Krakatau Integration**: Advanced bytecode assembler/disassembler
- **Class Manipulation**: Load, modify, and generate class files
- **Native Methods**: JNI (Java Native Interface) support
- **Build System**: Complete webpack-based build pipeline

## 📋 Use Cases

### Development & Analysis
- **Java Learning**: Study JVM internals and bytecode execution
- **Reverse Engineering**: Analyze and understand Java applications
- **Code Analysis**: Build static analysis tools for Java bytecode
- **Security Research**: Examine compiled Java applications

### Web Deployment
- **Legacy Migration**: Run Java applications in modern browsers
- **Cross-Platform Apps**: Deploy Java applications without JVM installation
- **Educational Tools**: Teach Java programming with browser execution

### Tool Development
- **Custom JVMs**: Build specialized Java runtime environments
- **Bytecode Tools**: Create advanced Java development utilities
- **Testing Frameworks**: Develop Java testing and debugging tools

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Basic Usage

#### Parse and Analyze a Java Class

```bash
# Compile a Java source file
javac sources/Hello.java

# Parse and analyze the class file
node scripts/runLoadAndTraverse.js Hello sources
```

#### Execute Java Bytecode

```bash
# Run a Java class with the custom JVM
node scripts/runJvm.js sources/Hello.class
```

#### Web-Based Debugging

```bash
# Start the development server
npm run serve
```

Then open http://localhost:3000 to access the debugging interface.

## 🏗️ Architecture

### Core Components

```
src/
├── jvm.js                 # Main JVM implementation and execution engine
├── frame.js              # Stack frame management and local variables
├── classLoader.js        # Dynamic class loading and resolution
├── debugController.js    # Debugging functionality and controls
├── browser-entry.js      # Browser-specific entry point and API
├── instructions/         # Complete bytecode instruction set
├── jre/                  # Java Runtime Environment implementation
├── awt.js               # Browser AWT (Abstract Window Toolkit)
└── convert_tree.js      # AST conversion and bytecode manipulation
```

### Key Features

#### JVM Runtime
- **Complete Bytecode Support**: All major JVM instructions implemented
- **Multi-threading**: Java thread model with synchronization
- **Exception Handling**: Full Java exception system
- **Memory Model**: Stack and heap management

#### Class Loading System
- **Dynamic Resolution**: Load classes at runtime
- **Verification**: Bytecode format validation
- **Linking**: Class preparation and initialization

#### Web Integration
- **Browser JVM**: Execute Java in web browsers
- **Visual Debugging**: Step-through interface
- **State Management**: Serialize and restore execution state

## 📚 Usage Examples

### 1. Basic Class Analysis

```javascript
const { loadClassByPath } = require('./src/classLoader');

// Load and parse a class file
const classData = await loadClassByPath('MyClass.class');
console.log('Class name:', classData.ast.classes[0].className);
console.log('Methods:', classData.ast.classes[0].items.filter(item => item.type === 'method'));
```

### 2. JVM Execution

```javascript
const { JVM } = require('./src/jvm');

const jvm = new JVM({
    verbose: true,
    classpath: 'sources'
});

// Execute a Java class
await jvm.run('Hello.class');
```

### 3. Web-Based Debugging

```javascript
// In browser environment
const { BrowserJVMDebug } = window.JVMDebug;

const debugger = new BrowserJVMDebug();

// Initialize with data package
await debugger.initialize({
    dataUrl: '/dist/data.zip'
});

// Start debugging session
await debugger.start('com.example.MyClass');

// Control execution
debugger.setBreakpoint(10);
debugger.stepInto();
debugger.continue();
```

### 4. Bytecode Manipulation

```javascript
const { getAST, convertJson } = require('./src/convert_tree');
const { unparseDataStructures } = require('./src/convert_tree');

// Parse class file
const classData = fs.readFileSync('MyClass.class');
const ast = getAST(classData);
const converted = convertJson(ast.ast, ast.constantPool);

// Modify the AST as needed
// ... modify converted.classes[0] ...

// Generate new bytecode
const newBytecode = unparseDataStructures(converted.classes[0], converted.constantPool);
```

See `docs/dead_code_elimination.md` for a detailed walkthrough of assembling `.j` sources, parsing the resulting `.class`, running the stack-based dead-code eliminator, and emitting updated assembly.

### Jasmin Lint & Fix CLI

Use the unified JVM CLI to surface the same dead-code diagnostics and jump-handler fixes that power the LSP workflow:

```bash
# Show diagnostics for a Jasmin file
node scripts/jvm-cli.js lint examples/sources/jasmin/MisplacedCatch.j

# Apply the recommended fix in place
node scripts/jvm-cli.js lint --fix examples/sources/jasmin/MisplacedCatch.j

# Or write the fix to a separate file
node scripts/jvm-cli.js lint --fix --out /tmp/MisplacedCatch.fixed.j examples/sources/jasmin/MisplacedCatch.j

# npm shortcut
npm run lint:jasmin -- --fix examples/sources/jasmin/MisplacedCatch.j
```

When `--fix` is supplied, the tool rewrites the target file (or the path provided via `--out`) with the optimized handler layout.

### Unified JVM CLI

The helper `scripts/jvm-cli.js` centralizes common JVM/Jasmin workflows:

```bash
# Assemble/disassemble
node scripts/jvm-cli.js assemble examples/sources/jasmin/MisplacedCatch.j
node scripts/jvm-cli.js disassemble build/classes/Hello.class --out /tmp/Hello.j

# Rename classes or methods in-place (works for .j and .class)
node scripts/jvm-cli.js rename-class examples/sources/jasmin/MisplacedCatch.j \
    --from MisplacedCatch --to MCatch -n   # dry-run; prints diff
node scripts/jvm-cli.js rename-method build/classes/Hello.class \
    --class Hello --from greet --to greetSafe --descriptor '()V'

# Dead-code optimization (alias for `lint --fix`)
node scripts/jvm-cli.js optimize examples/sources/jasmin/MisplacedCatch.j --out /tmp/MisplacedCatch.opt.j
```

Use `node scripts/jvm-cli.js --help` to see the complete list of subcommands and flags. All mutating operations accept `-n/--dry-run` to preview the unified diff without touching the input file.

## 🔧 Configuration

### JVM Options

```javascript
const jvm = new JVM({
    verbose: true,           // Enable detailed logging
    maxStackDepth: 1024,     // Maximum call stack depth
    classpath: 'lib',        // Default classpath
    debugMode: true,         // Enable debugging features
    enableAWT: true         // Enable AWT graphics support
});
```

### Build System

```bash
# Install dependencies
npm install

# Build Java sources
npm run build:java

# Build web bundle
npm run build

# Run tests
npm test

# Start development server
npm run serve
```

## 🌐 Web Interface

### Visual Debugger Features
- **Disassembly View**: Syntax-highlighted bytecode with current instruction indicator
- **Execution Controls**: Step into, over, out, continue, and rewind
- **State Inspection**: Real-time display of stack, locals, and JVM state
- **Breakpoint Management**: Set breakpoints by clicking in the disassembly view

### Sample Applications
- **Built-in Examples**: Pre-compiled Java test cases
- **File Upload**: Load your own .class and .jar files
- **Class Browser**: Navigate methods and fields

### AWT Graphics
- **Canvas Rendering**: Java GUI components in HTML5 Canvas
- **Event Translation**: Browser events converted to AWT events
- **Layout Support**: Proper component layout and rendering

## 🧪 Testing

Run the comprehensive test suite:

```bash
# Run all tests
npm test

# Run specific test categories
npm run test:arithmetic
npm run test:awt

# Run browser tests
npm run test:playwright
```

## 📁 Project Structure

```
├── src/                    # Core implementation
│   ├── jvm.js             # Main JVM engine
│   ├── classLoader.js     # Class loading system
│   ├── instructions/      # Bytecode instructions
│   ├── jre/               # Java Runtime Environment
│   └── awt.js             # Browser graphics
├── sources/               # Java source files and examples
├── test/                  # Test files and test runners
├── scripts/               # Build and utility scripts
├── examples/              # Web interface examples
├── tools/                 # External tools (Krakatau)
└── dist/                  # Built distribution files
```

## 🔗 Krakatau Integration

This project integrates with [Krakatau](https://github.com/Storyyeller/Krakatau), an advanced Java bytecode assembler/disassembler:

- **Disassembly**: Convert .class files to Krakatau assembly format
- **Assembly**: Generate .class files from Krakatau assembly
- **Manipulation**: Modify bytecode using assembly representation
- **Analysis**: Advanced bytecode analysis capabilities

## 🤝 Contributing

We welcome contributions! Areas for improvement:

- Additional bytecode instruction implementations
- Enhanced JRE class library coverage
- Improved web interface features
- Performance optimizations
- Documentation enhancements

## 📄 License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- **jvm_parser**: Java class file parsing library
- **Krakatau**: Advanced bytecode manipulation tools
- **Java Community**: Inspiration from various JVM implementations

---

**JVM Tools** - Advanced Java bytecode analysis and execution for modern development.
