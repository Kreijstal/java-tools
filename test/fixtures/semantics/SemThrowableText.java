import java.io.BufferedReader;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringReader;
import java.io.StringWriter;

// Throwable text as games build error reports: printStackTrace into a
// StringWriter, read back line by line, and messages of wrapped causes.
// Frame lines ("\tat ...", "\t... n more") are dropped: jvm.js records no
// frames, so only the throwable and cause lines are compared.
public class SemThrowableText {
    static final class Wrapper extends RuntimeException {
        Throwable inner;
        String context;
    }

    static String report(Throwable t) throws IOException {
        String prefix = "";
        if (t instanceof Wrapper) {
            Wrapper w = (Wrapper) t;
            t = w.inner;
            prefix = w.context + " | ";
        }
        StringWriter text = new StringWriter();
        PrintWriter out = new PrintWriter(text);
        t.printStackTrace(out);
        out.close();
        BufferedReader lines = new BufferedReader(new StringReader(text.toString()));
        StringBuilder kept = new StringBuilder(prefix);
        for (String line; (line = lines.readLine()) != null;) {
            if (!line.startsWith("\tat ") && !line.startsWith("\t...")) kept.append('[').append(line).append(']');
        }
        return kept.toString();
    }

    static Throwable sample(int i) {
        switch (i % 6) {
            case 0: return new RuntimeException();
            case 1: return new RuntimeException(new IOException("disk " + i));
            case 2: return new IllegalStateException("");
            case 3: return new RuntimeException("outer", new Error(new IOException()));
            case 4: return new Exception((Throwable) null);
            default: {
                Wrapper w = new Wrapper();
                w.inner = new RuntimeException();
                w.context = "f.<init>(" + i + ")";
                return w;
            }
        }
    }

    public static void main(String[] args) throws IOException {
        for (int i = 0; i < 6; i++) {
            Throwable t = sample(i);
            System.out.println(report(t));
            System.out.println(t.getMessage() + " / " + t);
        }
        int hash = 0;
        for (int i = 0; i < 3000; i++) hash = hash * 31 + report(sample(i)).hashCode();
        System.out.println("hash " + hash);
    }
}
