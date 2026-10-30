import assert from 'node:assert/strict';
import { browserConcurrency, ciOptions } from './ci-options.mjs';

export function testCiOptions() {
  assert.deepEqual(ciOptions([]), { scope: 'full', project: undefined });
  assert.deepEqual(ciOptions(['browser', 'workspace-390x844']), { scope: 'browser', project: 'workspace-390x844' });
  for (const args of [['full', 'workspace-390x844'], ['quality', '--grep=x'], ['browser', 'unknown'], ['docker', 'skip']]) {
    assert.throws(() => ciOptions(args), /Full CI cannot filter tests/u);
  }
  assert.equal(browserConcurrency(undefined, 12, 15 * 1024 ** 3), 4);
  assert.equal(browserConcurrency(undefined, 2, 15 * 1024 ** 3), 2);
  assert.equal(browserConcurrency(undefined, 12, 5 * 1024 ** 3), 1);
  assert.equal(browserConcurrency('8', 12, 32 * 1024 ** 3), 8);
  for (const value of ['0', '9', '1.5', '-1', 'false', '']) assert.throws(() => browserConcurrency(value), /CI_BROWSER_CONCURRENCY/u);
}
