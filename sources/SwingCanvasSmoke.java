import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.SwingUtilities;

public class SwingCanvasSmoke {
    public static void main(String[] args) {
        JFrame frame = new JFrame("Swing Canvas");
        frame.setSize(320, 240);

        JPanel panel = new JPanel();
        JLabel label = new JLabel("Initial");
        JButton button = new JButton("Press");

        panel.add(label);
        panel.add(button);
        frame.add(panel);

        SwingUtilities.invokeLater(new Runnable() {
            @Override
            public void run() {
                label.setText("Updated");
                button.setText("Clicked");
                frame.repaint();
                System.out.println("EDT label: " + label.getText());
                System.out.println("EDT button: " + button.getText());
            }
        });

        frame.setVisible(true);
        frame.repaint();

        System.out.println("Frame title: " + frame.getTitle());
        System.out.println("Panel size: " + panel.getComponentCount());
        System.out.println("Label text: " + label.getText());
        System.out.println("Button text: " + button.getText());
    }
}
