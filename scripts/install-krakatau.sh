#!/bin/bash

# Script to install and build Krakatau (krak2)
# Based on the Krakatau repository README: https://github.com/Storyyeller/Krakatau

set -e

echo "Installing Krakatau (krak2)..."

# Check if Rust and Cargo are available
if ! command -v cargo &> /dev/null; then
    echo "Rust toolchain not found. Installing via rustup (non-interactive)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

if ! command -v cargo &> /dev/null; then
    echo "Error: Failed to install Rust toolchain. Aborting Krakatau build." >&2
    exit 1
fi

# Create a directory for Krakatau if it doesn't exist
KRAKATAU_DIR="$PWD/tools/krakatau"
mkdir -p "$KRAKATAU_DIR"

# Check if Krakatau is already installed
if [ -d "$KRAKATAU_DIR/Krakatau" ]; then
    echo "Krakatau already exists in $KRAKATAU_DIR/Krakatau"
    echo "Updating to latest version..."
    cd "$KRAKATAU_DIR/Krakatau"
    git pull origin v2
else
    echo "Cloning Krakatau repository..."
    cd "$KRAKATAU_DIR"
    git clone https://github.com/Storyyeller/Krakatau.git
    cd Krakatau
fi

echo "Building Krakatau with Cargo..."
cargo build --release

if [ -f "target/release/krak2" ]; then
    echo "Krakatau built successfully!"
    echo "Binary location: $KRAKATAU_DIR/Krakatau/target/release/krak2"
else
    echo "Error: Build failed - krak2 binary not found"
    exit 1
fi

echo ""
echo "Usage examples:"
echo "  Disassemble a class file:"
echo "    $KRAKATAU_DIR/Krakatau/target/release/krak2 dis --out /tmp/output YourClass.class"
echo ""
echo "  Disassemble with roundtrip mode (bit-for-bit identical reassembly):"
echo "    $KRAKATAU_DIR/Krakatau/target/release/krak2 dis --out /tmp/output --roundtrip YourClass.class"
echo ""
echo "  Assemble a .j file back to .class:"
echo "    $KRAKATAU_DIR/Krakatau/target/release/krak2 asm --out /tmp/output YourClass.j"

# Create a convenience script for easy access
CONVENIENCE_SCRIPT="$PWD/scripts/krakatau-disasm"
cat > "$CONVENIENCE_SCRIPT" << EOF
#!/bin/bash
# Convenience wrapper for Krakatau disassembler
"$KRAKATAU_DIR/Krakatau/target/release/krak2" dis "\$@"
EOF

chmod +x "$CONVENIENCE_SCRIPT"
echo "Created convenience script: $CONVENIENCE_SCRIPT"
echo "You can now use: ./scripts/krakatau-disasm --out /tmp/output YourClass.class"