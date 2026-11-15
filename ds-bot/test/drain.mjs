// `--test-force-exit` lets a test file's process exit as soon as the reporter unpipes, while the
// last result frames can still sit in stdout's write queue. The parent runner then never sees that
// test and the run is green with one test fewer (upstream #1550: 1 of 200 runs, 4 of 400), so the
// gate must not trust the runner's summary until this is fixed.
//
// Waiting for the queue to flush, then exiting with the same code, keeps the forced exit and loses
// nothing: 0 of 400 runs missing with this preload. Only the per-file children exit that way, so
// only they are patched; the runner's own stdout is left alone.
const context = process.env.NODE_TEST_CONTEXT
if (typeof context === 'string' && context.startsWith('child')) {
  const exit = process.exit
  process.exit = (code) => {
    process.stdout.write('', () => exit(code))
  }
}
