#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getDisassembled } = require('./lib');

// Get the class file path from command line arguments
const classFilePath = process.argv[2];

if (!classFilePath) {
    console.error('Please provide the path to a class file.');
    process.exit(1);
}

// Read the class file
fs.readFile(classFilePath, (err, data) => {
    if (err) {
        console.error(`Error reading file: ${err.message}`);
        process.exit(1);
    }

    try {
        // Get the disassembled string
        const disassembled = getDisassembled(new Uint8Array(data));
        console.log(disassembled);
    } catch (error) {
        console.error(`Error disassembling file: ${error.message}`);
        process.exit(1);
    }
});
