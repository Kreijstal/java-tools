const { getAST } = require("jvm_parser");
const fs = require("fs");

// Load and parse the StaticVsInstanceTest class to see method structure
const classBytes = fs.readFileSync("sources/StaticVsInstanceTest.class");
const ast = getAST(classBytes);

console.log("AST methods:");
console.log(JSON.stringify(ast.ast.methods, null, 2));