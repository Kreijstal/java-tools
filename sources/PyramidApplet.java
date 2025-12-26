import java.applet.Applet;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.FlowLayout;
import java.awt.Graphics;
import java.awt.Image;
import java.awt.Panel;
import java.awt.Scrollbar;
import java.awt.event.AdjustmentEvent;
import java.awt.event.AdjustmentListener;

public class PyramidApplet extends Applet implements Runnable, AdjustmentListener {
    private static final double TARGET_X = 0.0;
    private static final double TARGET_Y = 0.0;
    private static final double TARGET_Z = 0.0;
    private static final double GRID_SIZE = 10.0;
    private static final double GRID_STEP = 1.0;
    private static final double ORBIT_RADIUS = 4.0;
    private static final double ORBIT_Y = 1.0;

    private volatile boolean running;
    private Thread animator;
    private double orbitAngle;
    private Image backBuffer;
    private volatile int speedValue = 35;
    private Scrollbar speedControl;

    @Override
    public void init() {
        setLayout(new BorderLayout());
        Panel controls = new Panel(new FlowLayout(FlowLayout.LEFT));
        speedControl = new Scrollbar(Scrollbar.HORIZONTAL, speedValue, 1, 1, 101);
        speedControl.setPreferredSize(new java.awt.Dimension(300, 16));
        speedControl.addAdjustmentListener(this);
        controls.add(speedControl);
        add(controls, BorderLayout.SOUTH);
    }
    private static class Face {
        final int[] indices;
        final Color color;
        double depth;

        Face(int[] indices, Color color) {
            this.indices = indices;
            this.color = color;
        }
    }

    @Override
    public void start() {
        if (animator == null) {
            running = true;
            animator = new Thread(this, "GridOrbit");
            animator.start();
        }
    }

    @Override
    public void stop() {
        running = false;
        if (animator != null) {
            animator.interrupt();
            animator = null;
        }
    }

    @Override
    public void run() {
        while (running) {
            double speed = speedValue / 60.0;
            orbitAngle += 0.01 * speed;
            repaint();
            try {
                Thread.sleep(16);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Override
    public void adjustmentValueChanged(AdjustmentEvent e) {
        speedValue = speedControl.getValue();
    }

    @Override
    public void paint(Graphics g) {
        int width = getWidth();
        int height = getHeight();
        if (width <= 0 || height <= 0) {
            return;
        }

        if (backBuffer == null || backBuffer.getWidth(this) != width || backBuffer.getHeight(this) != height) {
            backBuffer = createImage(width, height);
        }
        Graphics bg = backBuffer.getGraphics();

        renderScene(bg, width, height);
        g.drawImage(backBuffer, 0, 0, this);
    }

    @Override
    public void update(Graphics g) {
        paint(g);
    }

    private void renderScene(Graphics g, int width, int height) {
        double camX = Math.cos(orbitAngle) * ORBIT_RADIUS;
        double camY = ORBIT_Y;
        double camZ = Math.sin(orbitAngle) * ORBIT_RADIUS;

        g.setColor(new Color(18, 18, 22));
        g.fillRect(0, 0, width, height);

        double[] forward = normalize(new double[] {
            TARGET_X - camX,
            TARGET_Y - camY,
            TARGET_Z - camZ
        });
        double[] upRef = new double[] {0.0, 1.0, 0.0};
        double[] right = normalize(cross(forward, upRef));
        double[] up = cross(right, forward);

        int centerX = width / 2;
        int centerY = height / 2;
        double scale = Math.min(width, height) * 0.55;

        g.setColor(new Color(70, 78, 90));
        for (double x = -GRID_SIZE; x <= GRID_SIZE; x += GRID_STEP) {
            drawLine3D(g, centerX, centerY, scale, right, up, forward,
                camX, camY, camZ,
                x, 0.0, -GRID_SIZE,
                x, 0.0, GRID_SIZE);
        }

        for (double z = -GRID_SIZE; z <= GRID_SIZE; z += GRID_STEP) {
            drawLine3D(g, centerX, centerY, scale, right, up, forward,
                camX, camY, camZ,
                -GRID_SIZE, 0.0, z,
                GRID_SIZE, 0.0, z);
        }

        g.setColor(new Color(230, 126, 34));
        drawCircle3D(g, centerX, centerY, scale, right, up, forward, camX, camY, camZ,
            0.0, 0.0, 0.0, ORBIT_RADIUS, 120);

        drawPyramid(g, centerX, centerY, scale, right, up, forward, camX, camY, camZ);
    }

    private void drawPyramid(Graphics g, int cx, int cy, double scale,
                             double[] right, double[] up, double[] forward,
                             double camX, double camY, double camZ) {
        double half = 0.5;
        double[][] vertices = new double[][] {
            {-half, 0.0, -half},
            { half, 0.0, -half},
            { half, 0.0,  half},
            {-half, 0.0,  half},
            {0.0, 1.0, 0.0}
        };

        double[][] view = new double[vertices.length][3];
        double[][] screen = new double[vertices.length][2];
        boolean[] visible = new boolean[vertices.length];

        for (int i = 0; i < vertices.length; i++) {
            double[] v = toCameraSpace(right, up, forward, camX, camY, camZ,
                vertices[i][0], vertices[i][1], vertices[i][2]);
            view[i] = v;
            double[] p = projectCameraPoint(cx, cy, scale, v);
            if (v[2] > 0.2) {
                screen[i] = p;
                visible[i] = true;
            }
        }

        Face[] faces = new Face[] {
            new Face(new int[] {0, 1, 2, 3}, new Color(52, 152, 219)),
            new Face(new int[] {0, 1, 4}, new Color(231, 76, 60)),
            new Face(new int[] {1, 2, 4}, new Color(241, 196, 15)),
            new Face(new int[] {2, 3, 4}, new Color(46, 204, 113)),
            new Face(new int[] {3, 0, 4}, new Color(155, 89, 182))
        };

        for (Face face : faces) {
            double depth = 0.0;
            for (int idx : face.indices) {
                depth += view[idx][2];
            }
            face.depth = depth / face.indices.length;
        }

        for (int i = 0; i < faces.length - 1; i++) {
            for (int j = i + 1; j < faces.length; j++) {
                if (faces[i].depth < faces[j].depth) {
                    Face tmp = faces[i];
                    faces[i] = faces[j];
                    faces[j] = tmp;
                }
            }
        }

        for (Face face : faces) {
            double[] normal = computeNormal(view, face.indices);
            if (normal[2] >= 0.0) {
                continue;
            }
            boolean faceVisible = true;
            for (int idx : face.indices) {
                if (!visible[idx]) {
                    faceVisible = false;
                    break;
                }
            }
            if (!faceVisible) {
                continue;
            }
            int n = face.indices.length;
            int[] xs = new int[n];
            int[] ys = new int[n];
            for (int i = 0; i < n; i++) {
                int idx = face.indices[i];
                xs[i] = (int) screen[idx][0];
                ys[i] = (int) screen[idx][1];
            }
            g.setColor(face.color);
            g.fillPolygon(xs, ys, n);
            g.setColor(new Color(12, 12, 12));
            g.drawPolygon(xs, ys, n);
        }
    }

    private double[] computeNormal(double[][] points, int[] indices) {
        double[] a = points[indices[0]];
        double[] b = points[indices[1]];
        double[] c = points[indices[2]];
        double ux = b[0] - a[0];
        double uy = b[1] - a[1];
        double uz = b[2] - a[2];
        double vx = c[0] - a[0];
        double vy = c[1] - a[1];
        double vz = c[2] - a[2];
        double nx = uy * vz - uz * vy;
        double ny = uz * vx - ux * vz;
        double nz = ux * vy - uy * vx;
        double len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len == 0.0) {
            return new double[] {0.0, 0.0, 1.0};
        }
        return new double[] {nx / len, ny / len, nz / len};
    }

    private void drawLine3D(Graphics g, int cx, int cy, double scale,
                            double[] right, double[] up, double[] forward,
                            double camX, double camY, double camZ,
                            double x1, double y1, double z1,
                            double x2, double y2, double z2) {
        double[] v1 = toCameraSpace(right, up, forward, camX, camY, camZ, x1, y1, z1);
        double[] v2 = toCameraSpace(right, up, forward, camX, camY, camZ, x2, y2, z2);
        double near = 0.2;
        if (v1[2] < near && v2[2] < near) {
            return;
        }
        if (v1[2] < near || v2[2] < near) {
            double t = (near - v1[2]) / (v2[2] - v1[2]);
            if (v1[2] < near) {
                v1 = new double[] {
                    v1[0] + t * (v2[0] - v1[0]),
                    v1[1] + t * (v2[1] - v1[1]),
                    near
                };
            } else {
                v2 = new double[] {
                    v1[0] + t * (v2[0] - v1[0]),
                    v1[1] + t * (v2[1] - v1[1]),
                    near
                };
            }
        }
        double[] p1 = projectCameraPoint(cx, cy, scale, v1);
        double[] p2 = projectCameraPoint(cx, cy, scale, v2);
        g.drawLine((int) p1[0], (int) p1[1], (int) p2[0], (int) p2[1]);
    }

    private void drawCircle3D(Graphics g, int cx, int cy, double scale,
                              double[] right, double[] up, double[] forward,
                              double camX, double camY, double camZ,
                              double centerX3, double centerY3, double centerZ3,
                              double radius, int segments) {
        double prevX = centerX3 + radius;
        double prevZ = centerZ3;
        for (int i = 1; i <= segments; i++) {
            double theta = (2.0 * Math.PI * i) / segments;
            double x = centerX3 + Math.cos(theta) * radius;
            double z = centerZ3 + Math.sin(theta) * radius;
            drawLine3D(g, cx, cy, scale, right, up, forward,
                camX, camY, camZ,
                prevX, centerY3, prevZ,
                x, centerY3, z);
            prevX = x;
            prevZ = z;
        }
    }

    private double[] toCameraSpace(double[] right, double[] up, double[] forward,
                                   double camX, double camY, double camZ,
                                   double x, double y, double z) {
        double relX = x - camX;
        double relY = y - camY;
        double relZ = z - camZ;

        double vx = dot(new double[] {relX, relY, relZ}, right);
        double vy = dot(new double[] {relX, relY, relZ}, up);
        double vz = dot(new double[] {relX, relY, relZ}, forward);
        return new double[] {vx, vy, vz};
    }

    private double[] projectCameraPoint(int cx, int cy, double scale, double[] v) {
        double sx = cx + (v[0] / v[2]) * scale;
        double sy = cy - (v[1] / v[2]) * scale;
        return new double[] {sx, sy};
    }

    private double dot(double[] a, double[] b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    private double[] cross(double[] a, double[] b) {
        return new double[] {
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        };
    }

    private double[] normalize(double[] v) {
        double len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if (len == 0.0) {
            return new double[] {0.0, 0.0, 0.0};
        }
        return new double[] {v[0] / len, v[1] / len, v[2] / len};
    }
}
