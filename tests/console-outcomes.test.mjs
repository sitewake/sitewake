import assert from "node:assert/strict";
import test from "node:test";
import { recentOutcomeCounts } from "../lib/console/overview-metrics.ts";
// The install snippet moved to install-guide: onboarding and the connection settings page share one source.
import { installationSnippet } from "../lib/console/install-guide.ts";

test("recent results deduplicate episodes and keep unknown outcomes separate from failures", () => {
  const episode = (id, status) => ({ id, outcome: { status } });
  assert.deepEqual(recentOutcomeCounts([
    episode("a", "success"), episode("a", "success"), episode("b", "execution-fault"),
    episode("c", "unknown"), episode("d", "business-rejection"), episode("e", "no-result"),
  ]), { total: 5, success: 1, faults: 1, unknown: 1 });
  assert.deepEqual(recentOutcomeCounts([]), { total: 0, success: 0, faults: 0, unknown: 0 });
});

test("installation code uses the current host and cannot break out of an attribute", () => {
  const snippet = installationSnippet("http://localhost:3000/path", 'site"><img src=x>');
  assert.match(snippet, /src="http:\/\/localhost:3000\/sitewake.js"/);
  assert.match(snippet, /data-site-agent="site&quot;&gt;&lt;img src=x&gt;"/);
  assert.doesNotMatch(snippet, /<img/);
});
