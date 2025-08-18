#!/bin/bash

# JVM Crash Test Runner
# This script systematically tests Java programs to find JVM crashes and failures

echo "========================================"
echo "JVM Crash and Failure Test Suite"
echo "========================================"
echo ""

# Define test programs
declare -a CRASH_TESTS=(
    "SimpleArrayTest:Crashes on newarray instruction"
    "ArrayTest:Complex array operations"
    "StaticFieldTest:Crashes on getstatic instruction"
    "BoxingUnboxingTest:Crashes on sipush + boxing issues"
    "InstanceofTest:Crashes on newarray for int[] creation"
    "SynchronizationTest:Crashes on getstatic for static fields"
    "EnumTest:Crashes on getstatic for enum constants"
    "SipushTest:Crashes on sipush instruction"
    "TryCatchTest:Partial failure on exception methods"
    "NullPointerTest:JVM crash instead of proper NPE"
    "StackOverflowTest:Crashes on getstatic before stack overflow"
    "InnerClassTest:Missing JRE dependencies"
)

declare -a WORKING_TESTS=(
    "RecursionTest:Factorial calculation - should work"
    "Hello:Basic string printing - should work"
    "RuntimeArithmetic:Basic arithmetic operations - should work"
)

cd /home/runner/work/java-tools/java-tools

echo "=== TESTING PROGRAMS THAT SHOULD CRASH ==="
echo ""

for test_entry in "${CRASH_TESTS[@]}"; do
    IFS=':' read -r test_name description <<< "$test_entry"
    echo "Testing: $test_name ($description)"
    echo "----------------------------------------"
    
    # Test with our JVM (capture first few lines of error)
    echo "JVM output:"
    timeout 10s node scripts/runJvm.js -cp sources "$test_name" 2>&1 | head -n 5
    echo ""
    
    # Test with real Java for comparison (capture first few lines)
    echo "Real Java output:"
    timeout 10s java -cp sources "$test_name" 2>&1 | head -n 5
    echo ""
    echo "========================================"
    echo ""
done

echo "=== TESTING PROGRAMS THAT SHOULD WORK ==="
echo ""

for test_entry in "${WORKING_TESTS[@]}"; do
    IFS=':' read -r test_name description <<< "$test_entry"
    echo "Testing: $test_name ($description)"
    echo "----------------------------------------"
    
    # Test with our JVM
    echo "JVM output:"
    timeout 10s node scripts/runJvm.js -cp sources "$test_name" 2>&1
    echo ""
    
    # Test with real Java for comparison
    echo "Real Java output:"
    timeout 10s java -cp sources "$test_name" 2>&1
    echo ""
    echo "========================================"
    echo ""
done

echo "Test suite completed!"
echo "See JVM_CRASH_REPORT.md for detailed analysis."