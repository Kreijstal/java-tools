"use strict";

const { spawn } = require("child_process");
const readline = require("readline");

if (!process.env.JVM_DISABLE_AUDIO) {
  process.env.JVM_DISABLE_AUDIO = "1";
}

const runnerArgs = process.argv.slice(2);
const RUNNER_CMD = ["bash", ["run-tests.sh", ...runnerArgs]];

function runPlain() {
  return new Promise((resolve, reject) => {
    const proc = spawn(RUNNER_CMD[0], RUNNER_CMD[1], {
      stdio: "inherit",
    });
    proc.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`Tests terminated via signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`Tests exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function runWithSummary() {
  return new Promise((resolve, reject) => {
    const runner = spawn(RUNNER_CMD[0], RUNNER_CMD[1], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: runner.stdout });
    let total = 0;
    let failed = 0;
    let skippedFiles = 0;
    const failures = [];
    // A test file can fail without emitting a single TAP assertion: it may use
    // node:test rather than tape, time out, or throw while loading. Those show
    // up only as run-tests.sh's own "Test failed:" line, so track them
    // separately - otherwise the run prints "N tests passed" and then exits 1
    // with nothing to point at.
    const fileFailures = [];
    let collecting = null;
    let currentFile = null;
    let nodeTestDetail = null;

    // node:test prints its own summary instead of TAP. Fold its counts in so
    // the total is not silently short by every assertion in those files.
    const flushNodeTestDetail = () => {
      if (nodeTestDetail && nodeTestDetail.lines.length > 0) {
        failures.push([
          `not ok - ${nodeTestDetail.file} (node:test)`,
          ...nodeTestDetail.lines.map((entry) => `  ${entry}`),
        ]);
      }
      nodeTestDetail = null;
    };

    rl.on("line", (line) => {
      if (line.startsWith("Running test:")) {
        flushNodeTestDetail();
        currentFile = line.slice("Running test:".length).trim();
        collecting = null;
        process.stdout.write(`\n${line}\n`);
        return;
      }
      if (line.startsWith("Skipping test:")) {
        flushNodeTestDetail();
        skippedFiles += 1;
        currentFile = null;
        process.stdout.write(`\n${line}\n`);
        return;
      }
      if (line.startsWith("Test failed:")) {
        flushNodeTestDetail();
        fileFailures.push(line.slice("Test failed:".length).trim());
        return;
      }
      if (nodeTestDetail) {
        // tape still wraps the file, so its own empty "1..0 / # tests 0"
        // trailer follows node:test's report. Keep it out of the detail.
        if (!/^(1\.\.|# )/.test(line)) nodeTestDetail.lines.push(line);
        return;
      }
      const nodePass = /^\u2139 pass (\d+)$/.exec(line);
      if (nodePass) {
        const count = Number(nodePass[1]);
        total += count;
        process.stdout.write(".".repeat(count));
        return;
      }
      const nodeFail = /^\u2139 fail (\d+)$/.exec(line);
      if (nodeFail) {
        const count = Number(nodeFail[1]);
        total += count;
        failed += count;
        process.stdout.write("F".repeat(count));
        return;
      }
      if (/^\u2716 failing tests:$/.test(line)) {
        nodeTestDetail = { file: currentFile || "(unknown file)", lines: [] };
        return;
      }
      if (line.startsWith("TAP version")) {
        return;
      }
      if (/^1\.\./.test(line)) {
        return;
      }
      if (/^ok\b/.test(line)) {
        total += 1;
        process.stdout.write(".");
        collecting = null;
        return;
      }
      if (/^not ok\b/.test(line)) {
        total += 1;
        failed += 1;
        const record = [line];
        failures.push(record);
        collecting = record;
        process.stdout.write("F");
        return;
      }
      if (collecting && line.startsWith("  ")) {
        collecting.push(line);
      }
    });

    runner.stderr.pipe(process.stderr);

    runner.on("close", (code, signal) => {
      rl.close();
      flushNodeTestDetail();
      process.stdout.write("\n");
      if (failures.length > 0) {
        process.stdout.write(
          // `failed` counts assertions; `failures` counts reports, and a
          // node:test file contributes one report for all of its failures.
          `\n${failed} failing test(s) out of ${total}:\n\n`,
        );
        failures.forEach((record, index) => {
          process.stdout.write(`${index + 1}) ${record[0]}\n`);
          for (let i = 1; i < record.length; i += 1) {
            process.stdout.write(`${record[i]}\n`);
          }
          process.stdout.write("\n");
        });
      } else {
        const skippedSuffix = skippedFiles ? `, ${skippedFiles} test file(s) skipped` : '';
        process.stdout.write(`\n${total} tests passed${skippedSuffix}\n`);
      }

      if (fileFailures.length > 0) {
        process.stdout.write(
          `\n${fileFailures.length} test file(s) failed:\n`,
        );
        fileFailures.forEach((file) => {
          process.stdout.write(`  ${file}\n`);
        });
        process.stdout.write("\n");
      } else if (failures.length === 0 && code !== 0 && !signal) {
        // Nothing named itself, but the runner still failed. Say so rather than
        // leaving a bare "tests passed" next to a non-zero exit.
        process.stdout.write(
          "\nNo test reported a failure, yet the runner exited non-zero." +
            " Re-run with JVM_TEST_CONTINUE_ON_FAILURE=1 to see every file.\n",
        );
      }

      if (signal) {
        reject(new Error(`Tests terminated via signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`Tests exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

const isCI = Boolean(process.env.CI && process.env.CI !== "0");

(isCI ? runPlain() : runWithSummary())
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
