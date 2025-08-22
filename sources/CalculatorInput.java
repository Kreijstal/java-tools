import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.IOException;

public class CalculatorInput {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        String line;

        System.out.println("Simple Calculator (type 'exit' to quit)");
        System.out.println("Enter operations in format: number operator number");
        System.out.println("Example: 5 + 3");

        while (true) {
            System.out.print("> ");
            line = br.readLine();
            if (line == null || "exit".equals(line)) {
                break;
            }

            // Skip empty lines without using trim()
            if (line.length() == 0) {
                continue;
            }

            try {
                String[] parts = line.split("\\s+");
                if (parts.length != 3) {
                    System.out.println("Error: Please use format: number operator number");
                    continue;
                }

                double num1 = Double.parseDouble(parts[0]);
                String operator = parts[1];
                double num2 = Double.parseDouble(parts[2]);
                double result;

                switch (operator) {
                    case "+":
                        result = num1 + num2;
                        break;
                    case "-":
                        result = num1 - num2;
                        break;
                    case "*":
                        result = num1 * num2;
                        break;
                    case "/":
                        if (num2 == 0) {
                            System.out.println("Error: Division by zero");
                            continue;
                        }
                        result = num1 / num2;
                        break;
                    default:
                        System.out.println("Error: Unknown operator '" + operator + "'");
                        System.out.println("Supported operators: +, -, *, /");
                        continue;
                }

                System.out.println("Result: " + result);

            } catch (NumberFormatException e) {
                System.out.println("Error: Invalid number format");
            } catch (Exception e) {
                System.out.println("Error: " + e.getMessage());
            }
        }

        System.out.println("Calculator exited");
    }
}
