function loadClass(className,classPath) {

  console.log(`Attempt to load class ${className}`);
//if the class name path starts with java we ignore it for now
  //we look into our classpath and attempt to find the file
  const classFileContent = fs.readFileSync(classFilePath);
  const ast = getAST(new Uint8Array(classFileContent));
  const convertedAst = convertJson(ast.ast, ast.constantPool);
  return convertedAst;
}

module.exports = { loadClass };
