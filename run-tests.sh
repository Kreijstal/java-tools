#!/bin/bash
echo "Compiling Java sources..."
javac sources/*.java

for f in test/*.test.js; do
  if [ "$f" == "test/data-zip-download.test.js" ]; then
    continue
  fi
  echo "Running test: $f"
  timeout 10 tape "$f"
  if [ $? -ne 0 ]; then
    echo "Test failed: $f"
    exit 1
  fi
done
