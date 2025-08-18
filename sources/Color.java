enum Color {
    RED(255, 0, 0),
    GREEN(0, 255, 0),
    BLUE(0, 0, 255);
    
    private final int r, g, b;
    
    Color(int r, int g, int b) {
        this.r = r;
        this.g = g;
        this.b = b;
    }
    
    public int getRed() { return r; }
    public int getGreen() { return g; }
    public int getBlue() { return b; }
    
    public String getHex() {
        return String.format("#%02x%02x%02x", r, g, b);
    }
}