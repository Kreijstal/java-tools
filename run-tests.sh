#!/bin/bash
echo "Compiling Java sources..."
javac sources/*.java

for f in test/*.test.js; do
  if [ "$f" == "test/debug-enhanced.test.js" ] || [ "$f" == "test/debug.test.js" ]; then
    echo "Skipping test: $f (temporarily disabled due to threading changes)"
    continue
  fi
  echo "Running test: $f"
  tape "$f"
  if [ $? -ne 0 ]; then
    echo "Test failed: $f"
    exit 1
  fi
done
