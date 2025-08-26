// A Full Lifecycle Applet with fields
import java.applet.Applet;
import java.awt.Graphics;

public class FullLifecycleApplet extends Applet 
{
    private String message;
    
    public FullLifecycleApplet() {
        this.message = "Initializing...";
    }
    
    public void init() {
        this.message = "Initialized";
    }
    
    public void start() {
        this.message = "Started";
    }
    
    @Override
    public void paint(Graphics g) {
        g.drawString(this.message, 20, 20);
    }
}