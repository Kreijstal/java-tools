import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.util.function.ToDoubleFunction;

@Retention(RetentionPolicy.RUNTIME)
@interface CompileMarker {
    String value();
}

@CompileMarker("runtime")
public class CompileFeatureFixture {
    private static int hidden = 7;

    public ToDoubleFunction rawNumberFunction() {
        return value -> ((Number) value).doubleValue();
    }

    public static void main(String[] args) {
        CompileMarker marker = CompileFeatureFixture.class.getAnnotation(CompileMarker.class);
        if (marker == null || !"runtime".equals(marker.value())) {
            throw new AssertionError("runtime annotation was not preserved");
        }
    }

    static class Nested {
        int readHidden() {
            return hidden;
        }
    }

    enum Operation {
        ADD {
            int apply(int left, int right) {
                return left + right;
            }
        },
        SUBTRACT {
            int apply(int left, int right) {
                return left - right;
            }
        };

        abstract int apply(int left, int right);
    }
}
