public class StringInternTest {
    public static void main(String[] args) {
        System.out.println("=== String Intern Test ===");
        
        // Test literal string interning
        String s1 = "hello";
        String s2 = "hello";
        System.out.println("Literal strings s1 == s2: " + (s1 == s2));
        
        // Test constructed string vs literal
        String s3 = new String("hello");
        System.out.println("s1 == new String(\"hello\"): " + (s1 == s3));
        System.out.println("s1.equals(s3): " + s1.equals(s3));
        
        // Test intern() method
        String s4 = s3.intern();
        System.out.println("s1 == s3.intern(): " + (s1 == s4));
        
        // Test concatenation interning
        String concat1 = "hel" + "lo";
        String concat2 = "he" + "llo";
        System.out.println("\"hel\" + \"lo\" == \"he\" + \"llo\": " + (concat1 == concat2));
        System.out.println("concat1 == s1: " + (concat1 == s1));
        
        // Test runtime concatenation (should not be interned)
        String prefix = "hel";
        String runtime1 = prefix + "lo";
        String runtime2 = prefix + "lo";
        System.out.println("Runtime concat1 == runtime concat2: " + (runtime1 == runtime2));
        System.out.println("Runtime concat1 == literal: " + (runtime1 == s1));
        System.out.println("Runtime concat1.intern() == literal: " + (runtime1.intern() == s1));
        
        // Test StringBuilder result
        StringBuilder sb = new StringBuilder();
        sb.append("hel").append("lo");
        String sbResult = sb.toString();
        System.out.println("StringBuilder result == literal: " + (sbResult == s1));
        System.out.println("StringBuilder result.intern() == literal: " + (sbResult.intern() == s1));
        
        // Test with numbers
        String num1 = "123";
        String num2 = Integer.toString(123);
        String num3 = new String("123");
        System.out.println("Number literal \"123\" == Integer.toString(123): " + (num1 == num2));
        System.out.println("Number literal == new String(\"123\"): " + (num1 == num3));
        System.out.println("Integer.toString(123).intern() == \"123\": " + (num2.intern() == num1));
        
        // Test empty string
        String empty1 = "";
        String empty2 = new String("");
        String empty3 = empty2.intern();
        System.out.println("Empty literal \"\" == new String(\"\").intern(): " + (empty1 == empty3));
        
        // Test null intern (should throw NPE)
        try {
            String nullStr = null;
            String internNull = nullStr.intern();
            System.out.println("null.intern() succeeded: " + internNull);
        } catch (NullPointerException e) {
            System.out.println("null.intern() threw NullPointerException: " + e.getClass().getSimpleName());
        }
        
        // Test unique strings
        String unique1 = new String("unique_string_12345");
        String unique2 = new String("unique_string_12345");
        System.out.println("Two unique strings == : " + (unique1 == unique2));
        String unique1Intern = unique1.intern();
        String unique2Intern = unique2.intern();
        System.out.println("unique1.intern() == unique2.intern(): " + (unique1Intern == unique2Intern));
        System.out.println("unique1.intern() == unique1: " + (unique1Intern == unique1));
    }
}