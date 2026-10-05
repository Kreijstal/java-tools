import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.SwingUtilities;

public class SwingCanvasSmoke {
    static int painted;
    static JLabel label;
    static JButton button;

    static class Canvas extends JPanel {
        Canvas() { setPreferredSize(new Dimension(64, 32)); }
        @Override protected void paintComponent(Graphics g) {
            super.paintComponent(g);
            g.setColor(Color.RED);
            g.fillRect(0, 0, 10, 10);
            painted++;
        }
    }

    public static void main(String[] args) throws Exception {
        JFrame frame = new JFrame("Swing Canvas");
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        frame.setSize(320, 240);

        JPanel panel = new JPanel();
        label = new JLabel("Initial");
        button = new JButton("Press");
        Canvas canvas = new Canvas();
        panel.add(label);
        panel.add(button);
        panel.add(canvas);
        frame.add(panel);

        button.addActionListener(new ActionListener() {
            @Override
            public void actionPerformed(ActionEvent e) {
                label.setText("Clicked " + e.getActionCommand() + " " + 42);
            }
        });
        button.doClick();
        System.out.println("After doClick: " + label.getText());

        SwingUtilities.invokeAndWait(new Runnable() {
            @Override
            public void run() {
                button.setText("Done");
                System.out.println("EDT? " + SwingUtilities.isEventDispatchThread());
            }
        });
        System.out.println("Main EDT? " + SwingUtilities.isEventDispatchThread());

        frame.setVisible(true);
        System.out.println("Frame title: " + frame.getTitle());
        System.out.println("Panel size: " + panel.getComponentCount());
        System.out.println("Button text: " + button.getText());
        System.out.println("Painted: " + (painted > 0));

        SwingUtilities.invokeLater(new Runnable() {
            @Override
            public void run() { System.out.println("Later 1"); }
        });
        SwingUtilities.invokeLater(new Runnable() {
            @Override
            public void run() { System.out.println("Later 2 " + label.getText()); }
        });
    }
}
