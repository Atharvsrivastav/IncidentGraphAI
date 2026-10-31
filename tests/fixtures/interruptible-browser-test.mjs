import { spawn } from 'child_process';

const isWin = process.platform === 'win32';
// Spawn a nested worker process simulating Chrome/Chromium browser processes
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  detached: !isWin,
});

console.log(`INTERRUPTIBLE_BROWSER_READY:${process.pid}:${worker.pid}`);

if (process.send) {
  process.send({
    type: 'INTERRUPTIBLE_BROWSER_READY',
    browserPid: process.pid,
    workerPid: worker.pid,
  });
}

// Keep running until killed by process-tree termination
setInterval(() => {}, 1000);
