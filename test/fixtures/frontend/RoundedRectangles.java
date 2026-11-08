import java.awt.*;

public class RoundedRectangles extends Canvas {
    public static Canvas surface;

    public void paint(Graphics graphics) {
        Graphics2D g2 = (Graphics2D) graphics;
        g2.setColor(Color.BLUE);
        g2.fillRect(0, 0, 120, 90);
        g2.setColor(Color.RED);
        g2.fillRoundRect(10, 10, 40, 32, 20, 20);
        graphics.setColor(Color.GREEN);
        graphics.drawRoundRect(65, 10, 40, 32, 20, 20);
        g2.setColor(new Color(255, 0, 0, 128));
        g2.fillRoundRect(10, 55, 40, 20, 200, -200);
        g2.setColor(Color.WHITE);
        g2.fillRoundRect(65, 55, 10, 10, 0, 9);
        g2.drawRoundRect(85, 55, 10, 10, 0, 9);
        g2.drawRoundRect(110, 60, 0, 4, 9, 9);
        g2.fillRoundRect(-10, 78, 20, 10, 0, 0);
        g2.setColor(new Color(255, 0, 0, 128));
        g2.drawRoundRect(65, 75, 40, 10, 6, 6);
        g2.fillRoundRect(0, 0, -10, 10, 4, 4);
        g2.drawRoundRect(0, 0, 10, -10, 4, 4);
    }

    public static void main(String[] args) {
        surface = new RoundedRectangles();
        Frame frame = new Frame("Rounded rectangles");
        frame.add(surface);
        frame.setSize(120, 90);
        frame.setVisible(true);
    }
}
