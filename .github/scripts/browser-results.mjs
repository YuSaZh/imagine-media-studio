export function browserSummary(report) {
  const { expected = 0, unexpected = 0, flaky = 0, skipped = 0 } = report.stats ?? {};
  const names = [];
  const visit = suites => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) if (spec.tests?.some(test => test.status === 'flaky')) names.push(spec.title);
      visit(suite.suites);
    }
  };
  visit(report.suites);
  return { passed: expected, failed: unexpected, flaky, skipped, flakyTests: names };
}
