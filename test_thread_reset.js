#!/usr/bin/env node
/**
 * Test script to reproduce the thread accumulation issue
 * Run Hello program to completion, then debug it again
 */

const DebugController = require('./src/debugController');

async function testThreadReset() {
    console.log('=== Testing thread reset issue ===\n');
    
    // Use the same debug controller (as would happen in browser)
    console.log('1. First run - executing Hello to completion...');
    const debug = new DebugController({ classpath: ['sources'] });
    await debug.start('Hello');
    
    // Continue execution until completion
    while (debug.executionState === 'paused') {
        await debug.continue();
    }
    
    const threads1 = debug.getThreads();
    console.log(`   First run completed. Threads: ${threads1.length}`);
    console.log(`   Thread details:`, threads1.map(t => `${t.id}:${t.status}`));
    
    // Second run: Debug Hello again using the same debug controller
    console.log('\n2. Second run - debugging Hello again using same debug controller...');
    await debug.start('Hello');
    
    const threads2 = debug.getThreads();
    console.log(`   Second run started. Threads: ${threads2.length}`);
    console.log(`   Thread details:`, threads2.map(t => `${t.id}:${t.status}`));
    
    // Check if threads accumulated
    if (threads2.length > 1) {
        console.log('\n❌ ISSUE CONFIRMED: Thread array not reset - contains multiple threads!');
        console.log('   Expected: 1 thread (main)');
        console.log(`   Actual: ${threads2.length} threads`);
        return false;
    } else {
        console.log('\n✅ Thread array properly reset');
        return true;
    }
}

// Run the test
testThreadReset().catch(console.error);