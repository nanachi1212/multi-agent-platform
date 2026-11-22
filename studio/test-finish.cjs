// A test file that never reaches its last line must fail: an await that never settles lets Node exit 0 without a word.
// Usage, at the top of an entry-point test: const finished = require('./test-finish.cjs')('Name');
// then call finished() right before the PASS line.
module.exports = (name) => {
  let done = false;
  process.on('exit', () => {
    if (done || process.exitCode) return;
    console.error(`${name}: ended before the PASS line (an await never settled)`);
    process.exitCode = 1;
  });
  return () => { done = true; };
};
