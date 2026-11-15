// `--test-force-exit` lets a test file's process exit as soon as the reporter unpipes, while the
// last result frames can still sit in stdout's write queue. The parent runner then never sees that
// test and the run is green with one test fewer (upstream #1550: 1 of 200 runs, 4 of 400). Waiting
// for the queue to flush, then exiting with the same code, keeps the forced exit and loses nothing:
// a 1 MiB write delivered 65536 bytes without this and all 1048576 with it.
//
// Nothing passes that flag any more: with it the suite reported 2494 to 2507 tests where the same
// tree reports 2529, and about one run in three exited 1 with `fail 0`, so scripts/gate.sh and the
// test script drop it and pay the extra 68 seconds. This preload stays as the guard for anyone who
// adds it back by hand.
//
// It does not steady the result count on its own either: parallel runs end with 2486 to 2508 tests
// because the files share ports and temporary directories, so the gate runs --test-concurrency=1.
//
// Only the per-file children exit that way, so only they are patched; the runner's own stdout is
// left alone. The context name has a version suffix on some releases, hence the prefix check.
const context = process.env.NODE_TEST_CONTEXT
if (typeof context === 'string' && context.startsWith('child')) {
  const exit = process.exit
  process.exit = (code) => {
    process.stdout.write('', () => exit(code))
  }
}
