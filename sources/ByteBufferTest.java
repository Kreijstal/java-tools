import java.nio.ByteBuffer;
import java.nio.BufferOverflowException;
import java.nio.BufferUnderflowException;

public class ByteBufferTest {
    public static void main(String[] args) {
        System.out.println("=== ByteBuffer Test ===");

        // Test allocation and capacity
        ByteBuffer buffer = ByteBuffer.allocateDirect(10);
        System.out.println("Allocated buffer with capacity: " + buffer.capacity());
        if (buffer.capacity() != 10) {
            System.out.println("ERROR: Incorrect capacity!");
        }

        // Test put and get
        byte[] source = {1, 2, 3, 4, 5};
        buffer.put(source);
        System.out.println("Buffer position after put: " + buffer.position());
        if (buffer.position() != 5) {
            System.out.println("ERROR: Incorrect position after put!");
        }

        buffer.position(0);
        byte[] destination = new byte[5];
        buffer.get(destination);

        System.out.print("Read from buffer: [");
        boolean match = true;
        for (int i = 0; i < destination.length; i++) {
            System.out.print(destination[i]);
            if (source[i] != destination[i]) {
                match = false;
            }
            if (i < destination.length - 1) {
                System.out.print(", ");
            }
        }
        System.out.println("]");
        if (!match) {
            System.out.println("ERROR: Data read does not match data written!");
        }

        // Test BufferOverflowException
        try {
            byte[] tooLarge = new byte[6];
            buffer.put(tooLarge);
            System.out.println("ERROR: BufferOverflowException not thrown!");
        } catch (BufferOverflowException e) {
            System.out.println("Caught expected BufferOverflowException");
        }

        // Test BufferUnderflowException
        try {
            buffer.position(8);
            byte[] smallDest = new byte[3];
            buffer.get(smallDest);
            System.out.println("ERROR: BufferUnderflowException not thrown!");
        } catch (BufferUnderflowException e) {
            System.out.println("Caught expected BufferUnderflowException");
        }

        // Test IllegalArgumentException for position
        try {
            buffer.position(11);
            System.out.println("ERROR: IllegalArgumentException not thrown for position > limit!");
        } catch (IllegalArgumentException e) {
            System.out.println("Caught expected IllegalArgumentException for position > limit");
        }

        try {
            buffer.position(-1);
            System.out.println("ERROR: IllegalArgumentException not thrown for position < 0!");
        } catch (IllegalArgumentException e) {
            System.out.println("Caught expected IllegalArgumentException for position < 0");
        }


        System.out.println("=== Test Complete ===");
    }
}
