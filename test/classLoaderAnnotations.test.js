const test = require("tape");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runTest } = require("./test-helpers");

test("annotation arrays and nested annotations survive class loading", async (t) => {
  const classpath = fs.mkdtempSync(path.join(os.tmpdir(), "jvm-annotations-"));
  const sourcePath = path.join(classpath, "AnnotationNestedArrayHarness.java");
  const source = `
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
@interface NestedValue {
    String value();
}

@Retention(RetentionPolicy.RUNTIME)
@interface CompositeValue {
    Class<?>[] types();
    NestedValue nested();
}

@CompositeValue(
    types = {String.class, int.class},
    nested = @NestedValue("nested"))
public class AnnotationNestedArrayHarness {
    public static void main(String[] args) {
        CompositeValue annotation =
            AnnotationNestedArrayHarness.class.getAnnotation(CompositeValue.class);
        Class<?>[] types = annotation.types();
        System.out.println(types[0].getName() + ", " + types[1].getName());
        System.out.println(annotation.nested().value());
    }
}
`;

  try {
    fs.writeFileSync(sourcePath, source);
    execFileSync("javac", ["-d", classpath, sourcePath]);
    await runTest(
      "AnnotationNestedArrayHarness",
      "java.lang.String, int\nnested",
      t,
      { classpath, timeout: 3000 },
    );
  } finally {
    fs.rmSync(classpath, { recursive: true, force: true });
  }
  t.end();
});
