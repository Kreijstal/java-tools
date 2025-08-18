#!/bin/bash
echo "Compiling Java sources..."
javac sources/*.java

for f in test/*.test.js; do
  echo "Running test: $f"
  timeout 60 tape "$f"
  if [ $? -ne 0 ]; then
    echo "Test failed: $f"
    exit 1
  fi
done
