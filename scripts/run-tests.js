"use strict";

const { spawn } = require("child_process");
const readline = require("readline");

if (!process.env.JVM_DISABLE_AUDIO) {
  process.env.JVM_DISABLE_AUDIO = "1";
}

const RUNNER_CMD = ["bash", ["run-tests.sh"]];

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
    const failures = [];
    let collecting = null;

    rl.on("line", (line) => {
      if (line.startsWith("Running test:")) {
        process.stdout.write(`\n${line}\n`);
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
      process.stdout.write("\n");
      if (failures.length > 0) {
        process.stdout.write(
          `\n${failures.length} failing test(s) out of ${total}:\n\n`,
        );
        failures.forEach((record, index) => {
          process.stdout.write(`${index + 1}) ${record[0]}\n`);
          for (let i = 1; i < record.length; i += 1) {
            process.stdout.write(`${record[i]}\n`);
          }
          process.stdout.write("\n");
        });
      } else {
        process.stdout.write(`\n${total} tests passed\n`);
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
