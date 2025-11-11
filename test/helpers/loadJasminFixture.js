const fs = require('fs');
const path = require('path');
const { parseKrak2Assembly } = require('../../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../../src/convert_krak2_ast');

function loadJasminFixture(baseName) {
  const jasminPath = path.join(
    __dirname,
    '../../examples/sources/jasmin',
    `${baseName}.j`,
  );
  const assembly = fs.readFileSync(jasminPath, 'utf8');
  const krak2Ast = parseKrak2Assembly(assembly);
  return convertKrak2AstToClassAst(krak2Ast, { sourceText: assembly });
}

module.exports = { loadJasminFixture };
