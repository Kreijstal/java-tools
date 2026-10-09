import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.lang.model.type.TypeKind;
import javax.tools.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

// Compare complete attributed Java trees modulo only integral right-hand sign
// normalization and redundant parentheses. This is a source migration audit,
// not a proof of whole-program runtime behavior.
public final class IntegralTermAudit extends TreePathScanner<Void, StringBuilder> {
    private final Trees trees;
    private int rewrites;
    private IntegralTermAudit(JavacTask task) { trees = Trees.instance(task); }

    private static void word(StringBuilder out, Object value) {
        String text = String.valueOf(value); out.append(text.length()).append(':').append(text);
    }
    @Override public Void scan(Tree node, StringBuilder out) {
        if (node == null) { word(out, "null"); return null; }
        open(node, out);
        Void result = super.scan(node, out);
        close(node, out);
        return result;
    }
    @Override public Void scan(TreePath path, StringBuilder out) {
        open(path.getLeaf(), out);
        Void result = super.scan(path, out);
        close(path.getLeaf(), out);
        return result;
    }
    private void open(Tree node, StringBuilder out) {
        boolean parenthesized = node instanceof ParenthesizedTree;
        if (!parenthesized) {
            word(out, "(");
            if (!(node instanceof BinaryTree)) word(out, node.getKind());
            if (node instanceof IdentifierTree) word(out, ((IdentifierTree)node).getName());
            if (node instanceof MemberSelectTree) word(out, ((MemberSelectTree)node).getIdentifier());
            if (node instanceof MemberReferenceTree) {
                word(out, ((MemberReferenceTree)node).getName()); word(out, ((MemberReferenceTree)node).getMode());
            }
            if (node instanceof MethodTree) word(out, ((MethodTree)node).getName());
            if (node instanceof VariableTree) word(out, ((VariableTree)node).getName());
            if (node instanceof ClassTree) word(out, ((ClassTree)node).getSimpleName());
            if (node instanceof ModifiersTree) word(out, ((ModifiersTree)node).getFlags());
            if (node instanceof PrimitiveTypeTree) word(out, ((PrimitiveTypeTree)node).getPrimitiveTypeKind());
            if (node instanceof LabeledStatementTree) word(out, ((LabeledStatementTree)node).getLabel());
            if (node instanceof BreakTree) word(out, ((BreakTree)node).getLabel());
            if (node instanceof ContinueTree) word(out, ((ContinueTree)node).getLabel());
            if (node instanceof ImportTree) word(out, ((ImportTree)node).isStatic());
            if (node instanceof LambdaExpressionTree) word(out, ((LambdaExpressionTree)node).getBodyKind());
        }
    }
    private void close(Tree node, StringBuilder out) {
        if (!(node instanceof ParenthesizedTree)) word(out, ")");
    }
    @Override public Void visitLiteral(LiteralTree node, StringBuilder out) {
        literal(out, node.getValue()); return null;
    }
    private static void literal(StringBuilder out, Object value) {
        word(out, value == null ? "null" : value.getClass().getName());
        if (value instanceof Float) word(out, Float.floatToRawIntBits((Float)value));
        else if (value instanceof Double) word(out, Double.doubleToRawLongBits((Double)value));
        else word(out, value);
    }
    private TreePath withoutParentheses(TreePath path) {
        while (path.getLeaf() instanceof ParenthesizedTree)
            path = new TreePath(path, ((ParenthesizedTree)path.getLeaf()).getExpression());
        return path;
    }
    private static boolean operandWidth(TypeKind actual, TypeKind width) {
        return width == TypeKind.LONG ? actual == TypeKind.LONG
            : actual == TypeKind.INT || actual == TypeKind.BYTE || actual == TypeKind.SHORT || actual == TypeKind.CHAR;
    }
    @Override public Void visitBinary(BinaryTree node, StringBuilder out) {
        Tree.Kind kind = node.getKind();
        TypeKind width = trees.getTypeMirror(getCurrentPath()).getKind();
        TreePath right = new TreePath(getCurrentPath(), node.getRightOperand());
        Number positive = null;
        if ((width == TypeKind.INT || width == TypeKind.LONG) && (kind == Tree.Kind.PLUS || kind == Tree.Kind.MINUS)) {
            right = withoutParentheses(right);
            while (right.getLeaf().getKind() == Tree.Kind.UNARY_MINUS && trees.getTypeMirror(right).getKind() == width) {
                TreePath child = withoutParentheses(new TreePath(right, ((UnaryTree)right.getLeaf()).getExpression()));
                if (!operandWidth(trees.getTypeMirror(child).getKind(), width)) break;
                right = child; kind = kind == Tree.Kind.PLUS ? Tree.Kind.MINUS : Tree.Kind.PLUS; rewrites++;
            }
            if (right.getLeaf() instanceof LiteralTree) {
                Object value = ((LiteralTree)right.getLeaf()).getValue();
                if (width == TypeKind.INT && value instanceof Integer && (Integer)value < 0 && (Integer)value != Integer.MIN_VALUE)
                    positive = Integer.valueOf(-(Integer)value);
                if (width == TypeKind.LONG && value instanceof Long && (Long)value < 0 && (Long)value != Long.MIN_VALUE)
                    positive = Long.valueOf(-(Long)value);
                if (positive != null) { kind = kind == Tree.Kind.PLUS ? Tree.Kind.MINUS : Tree.Kind.PLUS; rewrites++; }
            }
        }
        word(out, kind); word(out, width); scan(node.getLeftOperand(), out);
        if (positive == null) scan(right, out);
        else {
            word(out, "("); word(out, positive instanceof Long ? Tree.Kind.LONG_LITERAL : Tree.Kind.INT_LITERAL);
            literal(out, positive); word(out, ")");
        }
        return null;
    }
    private static Map<String, String> signatures(Path root, String classpath) throws Exception {
        List<File> files = new ArrayList<>();
        try (java.util.stream.Stream<Path> walk = Files.walk(root)) {
            walk.filter(path -> path.toString().endsWith(".java")).sorted().forEach(path -> files.add(path.toFile()));
        }
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager manager = compiler.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask)compiler.getTask(null, manager, diagnostics,
                Arrays.asList("--release", "8", "-proc:none", "-encoding", "UTF-8", "-sourcepath", "", "-classpath", classpath),
                null, manager.getJavaFileObjectsFromFiles(files));
            List<CompilationUnitTree> units = new ArrayList<>(); for (CompilationUnitTree unit : task.parse()) units.add(unit);
            task.analyze();
            for (Diagnostic<?> item : diagnostics.getDiagnostics())
                if (item.getKind() == Diagnostic.Kind.ERROR) throw new IllegalArgumentException(item.toString());
            IntegralTermAudit scanner = new IntegralTermAudit(task); Map<String, String> result = new TreeMap<>();
            for (CompilationUnitTree unit : units) {
                StringBuilder out = new StringBuilder(); scanner.scan(unit, out);
                byte[] hash = MessageDigest.getInstance("SHA-256").digest(out.toString().getBytes(StandardCharsets.UTF_8));
                result.put(root.relativize(Paths.get(unit.getSourceFile().toUri())).toString(), Base64.getEncoder().encodeToString(hash));
            }
            System.out.println("Canonicalized " + scanner.rewrites + " integral sign nodes in " + files.size() + " files");
            return result;
        }
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("Usage: IntegralTermAudit BEFORE AFTER CLASSPATH");
        Map<String, String> before = signatures(Paths.get(args[0]).toAbsolutePath().normalize(), args[2]);
        Map<String, String> after = signatures(Paths.get(args[1]).toAbsolutePath().normalize(), args[2]);
        if (!before.equals(after)) {
            Set<String> differing = new TreeSet<>(before.keySet()); differing.addAll(after.keySet());
            differing.removeIf(file -> Objects.equals(before.get(file), after.get(file)));
            throw new IllegalArgumentException("Source changes exceed integral sign normalization: " + differing);
        }
        System.out.println("Matched all " + before.size() + " attributed Java trees");
    }
}
