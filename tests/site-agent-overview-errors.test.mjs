import assert from "node:assert/strict";
import test from "node:test";
import {
  SiteAgentDataError,
  classifySiteAgentError,
  siteAgentClientErrorMessage,
} from "../lib/site-knowledge/errors.ts";
import { copy, t } from "../lib/i18n/index.ts";

// Read from the dictionary: pinning the sentence here would pass while a reader saw
// the wrong language, which is the bug these messages had.
const diagnostic = t().diagnostic;

test("Site Agent client preserves actionable auth, permission, and resource errors", () => {
  assert.equal(siteAgentClientErrorMessage(401, { error: "unauthorized" }), diagnostic.unauthorized);
  assert.equal(siteAgentClientErrorMessage(403, { error: "site_agent_forbidden" }), diagnostic.site_agent_forbidden);
  assert.equal(siteAgentClientErrorMessage(404, { error: "site_agent_not_found" }), diagnostic.site_agent_not_found_pick_again);
  assert.equal(siteAgentClientErrorMessage(503, { error: "site_agent_database_failed" }), diagnostic.site_agent_database_failed);
  assert.equal(siteAgentClientErrorMessage(0, undefined), diagnostic.console_unreachable);
  // Every code the resolver can answer with must exist in both catalogs, or one
  // language silently falls through to a different message.
  for (const key of ["unauthorized", "site_agent_forbidden", "site_agent_not_found_pick_again", "site_agent_database_failed", "console_unreachable"]) {
    assert.ok(copy("zh").diagnostic[key]?.trim(), `zh is missing ${key}`);
    assert.ok(copy("en").diagnostic[key]?.trim(), `en is missing ${key}`);
    assert.notEqual(copy("zh").diagnostic[key], copy("en").diagnostic[key], `${key} is not translated`);
  }
});

test("Site Agent error classification keeps database and runner failures distinct", () => {
  const database = classifySiteAgentError(
    new SiteAgentDataError("site_agent_database_failed", "query failed", "site_agent_overview_database"),
    "site_agent_overview_failed",
    "site_agent_overview",
  );
  assert.deepEqual(database, {
    code: "site_agent_database_failed",
    status: 503,
    phase: "site_agent_overview_database",
    message: diagnostic.site_agent_database_failed,
    retryable: true,
  });

  const runner = classifySiteAgentError(
    new SiteAgentDataError("site_agent_runner_service_failed", "runner query failed", "site_agent_overview_runner"),
    "site_agent_overview_failed",
    "site_agent_overview",
  );
  assert.equal(runner.code, "site_agent_runner_service_failed");
  assert.equal(runner.phase, "site_agent_overview_runner");
  assert.equal(runner.status, 503);
});
