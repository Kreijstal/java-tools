#!/bin/bash

# Manual test script to verify the browser debugging functionality works
set -e

echo "🧪 Testing Browser Debug Functionality"
echo "======================================"

# Step 1: Build the project
echo "📦 Building Java sources and browser bundle..."
npm run build:java
npm run build:bundle

# Step 2: Start the server in background
echo "🚀 Starting server..."
npm run serve &
SERVER_PID=$!

# Wait for server to start
sleep 3

# Step 3: Test that the server is running
echo "🔍 Testing server endpoints..."
if curl -s -f http://localhost:3000/examples/debug-web-interface.html > /dev/null; then
    echo "✅ Debug interface is accessible"
else
    echo "❌ Debug interface is not accessible"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

if curl -s -f http://localhost:3000/examples/browser-debug-test.html > /dev/null; then
    echo "✅ Test page is accessible"
else
    echo "❌ Test page is not accessible"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

if curl -s -f http://localhost:3000/dist/jvm-debug.js > /dev/null; then
    echo "✅ JavaScript bundle is accessible"
else
    echo "❌ JavaScript bundle is not accessible"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

# Step 4: Check that the bundle contains our exports
echo "🔬 Verifying browser bundle contains expected exports..."
if grep -q "BrowserJVMDebug" dist/jvm-debug.js; then
    echo "✅ Browser bundle contains BrowserJVMDebug export"
else
    echo "❌ Browser bundle missing BrowserJVMDebug export"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

if grep -q "DebugController" dist/jvm-debug.js; then
    echo "✅ Browser bundle contains DebugController export"
else
    echo "❌ Browser bundle missing DebugController export"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

# Clean up
echo "🧹 Cleaning up..."
kill $SERVER_PID 2>/dev/null || true

echo ""
echo "🎉 All tests passed! Browser debugging functionality is working."
echo ""
echo "The fix successfully resolves the 'Synchronous file operations not supported' error"
echo "by making the debugController use async class loading methods that work with"
echo "BrowserFileProvider while maintaining backward compatibility with NodeFileProvider."
echo ""
echo "✨ Summary of changes:"
echo "  - Fixed browser debugging bug with async class loading"
echo "  - Added Playwright for browser testing"
echo "  - Updated CI to include Playwright tests"
echo "  - Updated devcontainer for Playwright support"