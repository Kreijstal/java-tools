// Regression: jvm.js honours `synchronized` BLOCKS (monitorenter/monitorexit
// bytecode) but ignores the ACC_SYNCHRONIZED flag on METHODS, so several
// threads run inside a synchronized method at once.
//
// Found via orbdefence on jvm.js: the game's audio pump (la.a, lj.b, lj.a) is
// built entirely from synchronized methods, and two threads call into it -- the
// audio thread (oa.run) and the game thread (OrbDefence.run -> tf.a -> lj.c).
// Without the monitor the game thread mutates the synth's voice list while the
// audio thread iterates it, so im.d(int) dereferences a cursor whose node has
// been unlinked and throws NPE. la.a() catches it, closes the SourceDataLine
// and parks it for two seconds -- music becomes inaudible.
//
// The synchronized-block case is the control: it must keep passing, which is
// what pins the defect to the method flag rather than to locking in general.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE = `
public class SyncMonitorProbe {
  static final SyncMonitorProbe LOCK = new SyncMonitorProbe();
  static int inside = 0, maxInside = 0;
  static volatile boolean violated = false;

  static final Object BLOCK_LOCK = new Object();
  static int blockInside = 0, maxBlockInside = 0;
  static volatile boolean blockViolated = false;

  // Sleeping inside the critical section guarantees the scheduler runs the
  // other threads while it is held, so this does not depend on quantum sizes.
  synchronized void criticalMethod() {
    inside++;
    if (inside > maxInside) maxInside = inside;
    if (inside != 1) violated = true;
    try { Thread.sleep(20); } catch (InterruptedException e) { }
    if (inside != 1) violated = true;
    inside--;
  }

  void criticalBlock() {
    synchronized (BLOCK_LOCK) {
      blockInside++;
      if (blockInside > maxBlockInside) maxBlockInside = blockInside;
      if (blockInside != 1) blockViolated = true;
      try { Thread.sleep(20); } catch (InterruptedException e) { }
      if (blockInside != 1) blockViolated = true;
      blockInside--;
    }
  }

  public static void main(String[] args) throws Exception {
    Thread[] threads = new Thread[3];
    for (int t = 0; t < threads.length; t++) {
      threads[t] = new Thread(new Runnable() {
        public void run() {
          for (int i = 0; i < 4; i++) { LOCK.criticalMethod(); LOCK.criticalBlock(); }
        }
      });
    }
    for (Thread t : threads) t.start();
    for (Thread t : threads) t.join();
    System.out.println("METHOD violated=" + violated + " maxInside=" + maxInside);
    System.out.println("BLOCK violated=" + blockViolated + " maxInside=" + maxBlockInside);
  }
}
`;

function hasJavac() {
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function compileProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-monitor-'));
  fs.writeFileSync(path.join(dir, 'SyncMonitorProbe.java'), SOURCE);
  execFileSync('javac', ['-d', dir, path.join(dir, 'SyncMonitorProbe.java')],
    { stdio: 'pipe' });
  return dir;
}

// Run in a child process: the guest's System.out does not go through this
// process's console.log, so in-process capture silently sees nothing.
function runProbe(dir) {
  return execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'runJvm.js'), '-cp', dir,
      'SyncMonitorProbe'],
    { encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function parse(output, prefix) {
  const match = new RegExp(
    prefix + ' violated=(true|false) maxInside=(\\d+)').exec(output);
  return match
    ? { violated: match[1] === 'true', maxInside: Number(match[2]) }
    : null;
}

test('synchronized methods exclude other threads (ACC_SYNCHRONIZED)', async (t) => {
  if (!hasJavac()) {
    t.skip('javac is unavailable; cannot build the probe');
    t.end();
    return;
  }
  let dir;
  try {
    dir = compileProbe();
  } catch (error) {
    t.skip('javac could not compile the probe: ' + error.message);
    t.end();
    return;
  }

  const output = runProbe(dir);
  const method = parse(output, 'METHOD');
  const block = parse(output, 'BLOCK');

  t.ok(method, 'the probe reported its synchronized-method result');
  t.ok(block, 'the probe reported its synchronized-block result');

  // Control: this path uses monitorenter/monitorexit and already works. If it
  // ever fails, the defect is in locking generally, not in the method flag.
  t.notOk(block && block.violated,
    'a synchronized block is never entered by two threads at once');
  t.equal(block && block.maxInside, 1,
    'at most one thread is inside a synchronized block');

  t.notOk(method && method.violated,
    'a synchronized method is never entered by two threads at once');
  t.equal(method && method.maxInside, 1,
    'at most one thread is inside a synchronized method');

  fs.rmSync(dir, { recursive: true, force: true });
  t.end();
});
