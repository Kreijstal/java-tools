'use strict';
// make/langtools/tools/propertiesparser/resources/templates.properties, the
// classpath resource PropertiesParser loads its code stubs from

module.exports = String.raw`toplevel.decl=\
    package {0};\n\
    \n\
    {1}\n\
    import com.sun.tools.javac.util.JCDiagnostic.DiagnosticFlag;\n\
    import com.sun.tools.javac.util.JCDiagnostic.Error;\n\
    import com.sun.tools.javac.util.JCDiagnostic.Warning;\n\
    import com.sun.tools.javac.util.JCDiagnostic.LintWarning;\n\
    import com.sun.tools.javac.util.JCDiagnostic.Note;\n\
    import com.sun.tools.javac.util.JCDiagnostic.Fragment;\n\
    import com.sun.tools.javac.code.Lint.LintCategory;\n\
    \n\
    import java.util.EnumSet;\n\
    \n\
    import static com.sun.tools.javac.util.JCDiagnostic.DiagnosticFlag.*;\n\
    \n\
    public class {2} '{'\n\
    {3}\n\
    '}'\n

import.decl=\
    import {0};

nested.decl =\
    public static class {0} '{'\n\
    {1}\n\
    '}'

factory.decl.method=\
    /**\n\
    ' '* {5}\n\
    ' '*/\n\
    {0}public static {1} {2}({3}) '{'\n\
    {4}\n\
    '}'

factory.decl.method.arg=\
    arg{0}

factory.decl.method.body=\
    return new {0}({1}, {2}, {3}, {4});

factory.decl.method.body.lint=\
    return new {0}({1}, {2}, {3}, {4}, {5});

factory.decl.field=\
    /**\n\
    ' '* {4}\n\
    ' '*/\n\
    public static final {0} {1} = new {0}({2}, {3}, {4});

factory.decl.field.lint=\
    /**\n\
    ' '* {5}\n\
    ' '*/\n\
    public static final {0} {1} = new {0}({2}, {3}, {4}, {5});

wildcards.extends=\
    {0}<? extends {1}>

suppress.warnings=\
  @SuppressWarnings("rawtypes")\n

lint.category=\
  LintCategory.{0}

diagnostic.flags.empty=\
  EnumSet.noneOf(DiagnosticFlag.class)

diagnostic.flags.non-empty=\
  EnumSet.of({0})

`;
