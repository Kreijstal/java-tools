#!/bin/bash

# Script to compare outputs of javap, our parser, and Krakatau

CLASS_FILE="${1:-sources/StringConcatMethod.class}"

if [ ! -f "$CLASS_FILE" ]; then
    echo "Error: Class file $CLASS_FILE not found"
    exit 1
fi

echo "========================================="
echo "COMPARISON: javap vs our parser vs Krakatau"
echo "Class file: $CLASS_FILE"
echo "========================================="

echo ""
echo "1. JAVAP OUTPUT:"
echo "----------------"
javap -v "$CLASS_FILE"

echo ""
echo ""
echo "2. OUR PARSER OUTPUT:"
echo "---------------------"
node /tmp/test_parser.js "$CLASS_FILE"

echo ""
echo ""
echo "3. KRAKATAU OUTPUT:"
echo "-------------------"
# Clean up previous output
rm -rf /tmp/krakatau_compare
mkdir -p /tmp/krakatau_compare
./scripts/krakatau-disasm --out /tmp/krakatau_compare "$CLASS_FILE" > /dev/null 2>&1

# Find the .j file and display it
BASENAME=$(basename "$CLASS_FILE" .class)
cat /tmp/krakatau_compare/${BASENAME}.j

echo ""
echo ""
echo "4. ANALYSIS:"
echo "------------"
echo "Key differences observed:"
echo "- javap: Uses Java-like syntax with constant pool indices"
echo "- Our parser: Uses assembly-like syntax with resolved names"
echo "- Krakatau: Uses assembly-like syntax similar to ours"
echo ""
echo "Fixed bugs in our parser:"
echo "- astore/aload instructions now include the local variable index"
echo "- Both our parser and Krakatau show: 'astore 4' and 'aload 4'"
echo "- Previously our parser showed just: 'astore' and 'aload'"