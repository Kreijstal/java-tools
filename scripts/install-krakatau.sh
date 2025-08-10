#!/bin/bash

set -euo pipefail

# Script to install and build Krakatau (krak2)
# Based on the Krakatau repository README: https://github.com/Storyyeller/Krakatau

echo "Installing Krakatau (krak2)..."

# Remember project root (directory where this script was launched)
PROJECT_ROOT="$(pwd)"

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
    echo "Updating to latest version (fast-forward only if possible)..."
    cd "$KRAKATAU_DIR/Krakatau"
    if ! git pull --ff-only; then
        echo "Non fast-forward update; resetting to remote master" >&2
        git fetch origin master
        git reset --hard origin/master
    fi
else
    echo "Cloning Krakatau repository (master branch)..."
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

echo "Creating convenience disassembler wrapper script..."
mkdir -p "$PROJECT_ROOT/scripts"
CONVENIENCE_SCRIPT="$PROJECT_ROOT/scripts/krakatau-disasm"
TMP_SCRIPT="${CONVENIENCE_SCRIPT}.tmp$$"
cat > "$TMP_SCRIPT" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Convenience wrapper for Krakatau disassembler
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve project root (one level up from scripts)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KRAKATAU_BIN="$PROJECT_ROOT/tools/krakatau/Krakatau/target/release/krak2"
if [ ! -x "$KRAKATAU_BIN" ]; then
    echo "Error: Krakatau binary not found at $KRAKATAU_BIN" >&2
    exit 1
fi
"$KRAKATAU_BIN" dis "$@"
EOF
mv "$TMP_SCRIPT" "$CONVENIENCE_SCRIPT"
chmod +x "$CONVENIENCE_SCRIPT"
echo "Created convenience script: $CONVENIENCE_SCRIPT"
echo "You can now run: bash scripts/krakatau-disasm --out /tmp/output sources/Hello.class"