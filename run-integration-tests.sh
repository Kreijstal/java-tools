#!/bin/bash
echo "Running integration tests..."
timeout 60 tape test/data-zip-download.test.js
if [ $? -ne 0 ]; then
  echo "Integration test failed: test/data-zip-download.test.js"
  exit 1
fi
