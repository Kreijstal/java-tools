import java.awt.*;
import java.awt.event.*;
public class Cube3D extends Canvas implements MouseListener, MouseMotionListener {
  double ax=0.35, ay=0.5, zoom=6;
  boolean spinning=true;
  int lastX,lastY;
  boolean dragging=false;
  int frames=0;
  final double[][] vertices={
    {-1,-1,-1},{1,-1,-1},{1,1,-1},{-1,1,-1},
    {-1,-1,1},{1,-1,1},{1,1,1},{-1,1,1}
  };
  final int[][] edges={
    {0,1},{1,2},{2,3},{3,0},
    {4,5},{5,6},{6,7},{7,4},
    {0,4},{1,5},{2,6},{3,7}
  };
  final int[][] faces={
    {0,1,2,3},{4,5,6,7},{0,1,5,4},
    {2,3,7,6},{1,2,6,5},{0,3,7,4}
  };
  final Color[] colors={
    new Color(54,124,223),new Color(20,201,185),
    new Color(225,106,151),new Color(249,173,69),
    new Color(137,104,235),new Color(53,198,121)
  };
  public Cube3D(){
    setBackground(new Color(8,13,26));
    addMouseListener(this);
    addMouseMotionListener(this);
  }
  public void tick(){
    if(spinning && !dragging){ay+=0.025;ax+=0.006;repaint();}
  }
  public void setZoom(double z){zoom=z;repaint();}
  public void setSpinning(boolean s){spinning=s;}
  public void reset(){ax=.35;ay=.5;zoom=6;spinning=true;repaint();}
  public void paint(Graphics g){
    int w=getWidth(),h=getHeight();
    if(w<1 || h<1)return;
    Graphics2D g2=(Graphics2D)g;
    g2.setColor(new Color(8,13,26));
    g2.fillRect(0,0,w,h);
    g2.setColor(new Color(28,43,65));
    for(int i=0;i<w;i+=32)g2.drawLine(i,0,i,h);
    for(int j=0;j<h;j+=32)g2.drawLine(0,j,w,j);
    double[][] p=new double[8][3];
    int[][] screen=new int[8][2];
    double ca=Math.cos(ax),sa=Math.sin(ax);
    double cb=Math.cos(ay),sb=Math.sin(ay);
    double scale=Math.min(w,h)*1.15;
    for(int i=0;i<8;i++){
      double x=vertices[i][0],y=vertices[i][1],z=vertices[i][2];
      double x1=x*cb+z*sb,z1=-x*sb+z*cb;
      double y2=y*ca-z1*sa,z2=y*sa+z1*ca;
      p[i][0]=x1;p[i][1]=y2;p[i][2]=z2;
      double factor=scale/(zoom-z2);
      screen[i][0]=(int)(w/2+x1*factor);
      screen[i][1]=(int)(h/2-y2*factor);
    }
    int[] order={0,1,2,3,4,5};
    double[] depths=new double[6];
    for(int f=0;f<6;f++){
      for(int v:faces[f])depths[f]+=p[v][2];
      depths[f]/=4;
    }
    for(int i=0;i<6;i++){
      for(int j=i+1;j<6;j++){
        if(depths[order[i]]>depths[order[j]]){
          int t=order[i];order[i]=order[j];order[j]=t;
        }
      }
    }
    for(int f:order){
      int[] xs=new int[4],ys=new int[4];
      for(int k=0;k<4;k++){
        xs[k]=screen[faces[f][k]][0];ys[k]=screen[faces[f][k]][1];
      }
      Color c=colors[f];
      g2.setColor(new Color(c.getRed(),c.getGreen(),c.getBlue(),165));
      g2.fillPolygon(xs,ys,4);
      g2.setColor(new Color(188,225,255));
      g2.drawPolygon(xs,ys,4);
    }
    for(int i=0;i<8;i++){
      g2.setColor(Color.WHITE);
      g2.fillOval(screen[i][0]-3,screen[i][1]-3,6,6);
    }
    g2.setFont(new Font("SansSerif",Font.PLAIN,12));
    g2.setColor(new Color(176,199,229));
    g2.drawString("JAVA AWT  /  SOFTWARE 3D",14,22);
    g2.drawString("X "+(int)Math.toDegrees(ax)+"  Y "+(int)Math.toDegrees(ay),14,h-14);
  }
  public void update(Graphics g){paint(g);}
  public void mousePressed(MouseEvent e){dragging=true;lastX=e.getX();lastY=e.getY();}
  public void mouseReleased(MouseEvent e){dragging=false;}
  public void mouseDragged(MouseEvent e){
    ay+=(e.getX()-lastX)*.012;ax+=(e.getY()-lastY)*.012;
    lastX=e.getX();lastY=e.getY();repaint();
  }
  public void mouseClicked(MouseEvent e){}
  public void mouseEntered(MouseEvent e){}
  public void mouseExited(MouseEvent e){}
  public void mouseMoved(MouseEvent e){}
  public static void main(String[] args){
    Frame frame=new Frame("Java 3D");
    Cube3D cube=new Cube3D();
    frame.add(cube);frame.setSize(650,390);frame.setVisible(true);
    while(true){
      cube.tick();
      try{Thread.sleep(30);}catch(InterruptedException e){break;}
    }
  }
}
