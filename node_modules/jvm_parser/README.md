# JVM Parser

A command-line tool to disassemble Java class files and obtain their Abstract Syntax Tree (AST) representation.

## Features

- Disassemble Java class files to human-readable format.
- Retrieve the AST form of Java class files.

## Installation

To install the tool, use the following command:

```bash
npm install jvm_parser
```

## Development Installation

To install the tool from the master branch for development purposes, use the following commands:

```bash
git clone https://github.com/Kreijstal/jvm-parser.git
cd jvm-parser
npm install
```

This will clone the repository, navigate into the project directory, and install the necessary dependencies.

### Disassemble a Class File

To disassemble a class file, use the following command:

```bash
npx -p jvm_parser disassembler path/to/your/hello.class
```

This will output the disassembled string of the specified class file.

### Get AST Form

To get the AST form of a class file, you can use the `getAST` function from the `decompiler.js` module in your Node.js application:

```javascript
const { getAST } = require('jvm-parser');
const fs = require('fs');

fs.readFile('path/to/your/hello.class', (err, data) => {
    if (err) throw err;
    const ast = getAST(data);
    console.log(ast);
});
```

## License

This project is licensed under the AGPLv3 License.
