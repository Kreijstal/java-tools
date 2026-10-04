'use strict';
// Compact S-expression rendering of expression trees, for tests.
function sx(t) {
  if (t === null || t === undefined) return '_';
  switch (t.tag) {
    case 'Ident': return t.name;
    case 'Literal': return t.typetag === 'String' ? JSON.stringify(t.value) : String(t.value) + (t.typetag === 'long' ? 'L' : '');
    case 'Select': return `${sx(t.selected)}.${t.name}`;
    case 'Parens': return `(${sx(t.expr)})`;
    case 'Binary': return `(${t.op} ${sx(t.lhs)} ${sx(t.rhs)})`;
    case 'Unary': return `(${t.op} ${sx(t.arg)})`;
    case 'Assign': return `(= ${sx(t.lhs)} ${sx(t.rhs)})`;
    case 'AssignOp': return `(${t.op}= ${sx(t.lhs)} ${sx(t.rhs)})`;
    case 'Conditional': return `(? ${sx(t.cond)} ${sx(t.truepart)} ${sx(t.falsepart)})`;
    case 'TypeCast': return `(cast ${sx(t.clazz)} ${sx(t.expr)})`;
    case 'InstanceOf': return `(instanceof ${sx(t.expr)} ${t.pattern ? sx(t.pattern) : sx(t.clazz)})`;
    case 'BindingPattern': return `[${sx(t.var.vartype)} ${t.var.name}]`;
    case 'RecordPattern': return `[${sx(t.deconstructor)}(${t.nested.map(sx).join(' ')})]`;
    case 'Apply': return `(call ${sx(t.meth)}${t.typeargs.length ? '<' + t.typeargs.map(sx).join(',') + '>' : ''} ${t.args.map(sx).join(' ')})`;
    case 'NewClass': return `(new ${t.encl ? sx(t.encl) + '.' : ''}${sx(t.clazz)} ${t.args.map(sx).join(' ')}${t.body ? ' {...}' : ''})`;
    case 'NewArray': return `(newarray ${sx(t.elemtype)} [${t.dims.map(sx).join(' ')}] ${t.elems ? '{' + t.elems.map(sx).join(' ') + '}' : ''})`;
    case 'Indexed': return `${sx(t.indexed)}[${sx(t.index)}]`;
    case 'Lambda': return `(lambda (${t.params.map((p) => (p.vartype ? sx(p.vartype) + ' ' : '') + p.name).join(' ')}) ${t.body.tag === 'Block' ? '{...}' : sx(t.body)})`;
    case 'Reference': return `(ref ${sx(t.expr)} ${t.name})`;
    case 'PrimitiveType': return t.typetag;
    case 'ArrayType': return `${sx(t.elemtype)}[]`;
    case 'TypeApply': return `${sx(t.clazz)}<${t.args.map(sx).join(',')}>`;
    case 'Wildcard': return t.kind === 'unbound' ? '?' : `? ${t.kind} ${sx(t.bound)}`;
    case 'TypeIntersection': return t.bounds.map(sx).join('&');
    case 'AnnotatedType': return `@${sx(t.underlying)}`;
    case 'SwitchExpression': return `(switch ${sx(t.selector)} ...)`;
    default: return `<${t.tag}>`;
  }
}
module.exports = { sx };
