import java.applet.Applet;
import java.awt.Color;
import java.awt.Graphics;

public class RedBallApplet extends Applet {
    private Color ballColor = Color.RED;

    @Override
    public void init() {
        ballColor = Color.RED;
    }

    @Override
    public void paint(Graphics g) {
        int diameter = Math.min(getWidth(), getHeight()) - 20;
        if (diameter < 10) {
            diameter = 10;
        }
        int x = (getWidth() - diameter) / 2;
        int y = (getHeight() - diameter) / 2;

        g.setColor(ballColor != null ? ballColor : Color.RED);
        g.fillOval(x, y, diameter, diameter);
    }

    public void handleClick(int clickX, int clickY) {
        int diameter = Math.min(getWidth(), getHeight()) - 20;
        if (diameter < 10) {
            diameter = 10;
        }
        int x = (getWidth() - diameter) / 2;
        int y = (getHeight() - diameter) / 2;
        int radius = diameter / 2;
        int centerX = x + radius;
        int centerY = y + radius;
        int dx = clickX - centerX;
        int dy = clickY - centerY;

        if ((dx * dx + dy * dy) <= (radius * radius)) {
            int r = (int) (Math.random() * 256);
            int g = (int) (Math.random() * 256);
            int b = (int) (Math.random() * 256);
            ballColor = new Color(r, g, b);
            repaint();
        }
    }
}
