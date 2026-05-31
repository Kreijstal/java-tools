#!/bin/bash

set -u

continue_on_failure="${JVM_TEST_CONTINUE_ON_FAILURE:-0}"
skip_patterns=()
test_args=()
failures=()

add_skip_patterns() {
  local raw="$1"
  local old_ifs="$IFS"
  IFS=',; '
  for pattern in $raw; do
    if [ -n "$pattern" ]; then
      skip_patterns+=("$pattern")
    fi
  done
  IFS="$old_ifs"
}

if [ -n "${JVM_TEST_SKIP:-}" ]; then
  add_skip_patterns "$JVM_TEST_SKIP"
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --skip)
      if [ $# -lt 2 ]; then
        echo "--skip requires a test-name or glob pattern" >&2
        exit 1
      fi
      skip_patterns+=("$2")
      shift 2
      ;;
    --skip=*)
      skip_patterns+=("${1#--skip=}")
      shift
      ;;
    --continue-on-failure)
      continue_on_failure=1
      shift
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        test_args+=("$1")
        shift
      done
      ;;
    *)
      test_args+=("$1")
      shift
      ;;
  esac
done

should_skip_test() {
  local test_file="$1"
  local base
  base="$(basename "$test_file")"
  for pattern in "${skip_patterns[@]}"; do
    if [[ "$test_file" == $pattern ]] || [[ "$base" == $pattern ]] || [[ "$test_file" == *"$pattern"* ]] || [[ "$base" == *"$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

# Function to run a single test file
run_test() {
  local test_file="$1"

  if should_skip_test "$test_file"; then
    echo "Skipping test: $test_file"
    return 0
  fi

  echo "Running test: $test_file"

  local timeout_cmd=(timeout 15)
  case "$test_file" in
    *data-zip-download*) timeout_cmd=(timeout 60);;
    */hierarchyRename.test.js) timeout_cmd=(timeout 60);;
    */javaFrontendAllJavaCompile.test.js) timeout_cmd=(timeout 60);;
    */roundtrip.test.js) timeout_cmd=();; # roundtrip enforces per-case timeouts internally
    # Add other special cases here
  esac

  local tape_cmd=(node node_modules/tape/bin/tape)
  if [ ${#timeout_cmd[@]} -eq 0 ]; then
    "${tape_cmd[@]}" "$test_file"
  else
    "${timeout_cmd[@]}" "${tape_cmd[@]}" "$test_file"
  fi

  local status=$?
  if [ $status -ne 0 ]; then
    echo "Test failed: $test_file"
    if [ "$continue_on_failure" = "1" ]; then
      failures+=("$test_file")
      return 0
    fi
    exit $status
  fi
}

resolve_test_arg() {
  local arg="$1"
  if [[ "$arg" == *.test.js ]]; then
    # If it's a .test.js file, run it directly
    if [ -f "$arg" ]; then
      echo "$arg"
      return 0
    elif [ -f "test/$arg" ]; then
      echo "test/$arg"
      return 0
    else
      echo "Test file not found: $arg" >&2
      return 1
    fi
  else
    # If it's not a .test.js file, assume it's a test name and look for it
    local test_file="test/${arg}.test.js"
    if [ -f "$test_file" ]; then
      echo "$test_file"
      return 0
    else
      echo "Test file not found: $test_file" >&2
      return 1
    fi
  fi
}

if [ ${#test_args[@]} -gt 0 ]; then
  for arg in "${test_args[@]}"; do
    test_file="$(resolve_test_arg "$arg")" || exit 1
    run_test "$test_file"
  done
else
  # If no arguments provided, run all tests
  for f in test/*.test.js; do
    run_test "$f"
  done
fi

if [ ${#failures[@]} -gt 0 ]; then
  echo
  echo "${#failures[@]} test file(s) failed:"
  for f in "${failures[@]}"; do
    echo "  $f"
  done
  exit 1
fi
