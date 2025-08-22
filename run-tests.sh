#!/bin/bash

# Function to run a single test file
run_test() {
  local test_file="$1"
  echo "Running test: $test_file"
  timeout 60 ./node_modules/.bin/tape "$test_file"
  if [ $? -ne 0 ]; then
    echo "Test failed: $test_file"
    exit 1
  fi
}

echo "Compiling Java sources..."
javac sources/*.java

# If arguments are provided, run specific tests
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    if [[ "$arg" == *.test.js ]]; then
      # If it's a .test.js file, run it directly
      if [ -f "$arg" ]; then
        run_test "$arg"
      elif [ -f "test/$arg" ]; then
        run_test "test/$arg"
      else
        echo "Test file not found: $arg"
        exit 1
      fi
    else
      # If it's not a .test.js file, assume it's a test name and look for it
      test_file="test/${arg}.test.js"
      if [ -f "$test_file" ]; then
        run_test "$test_file"
      else
        echo "Test file not found: $test_file"
        exit 1
      fi
    fi
  done
else
  # If no arguments provided, run all tests
  for f in test/*.test.js; do
    run_test "$f"
  done
fi
