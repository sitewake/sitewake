import assert from "node:assert/strict";
import test from "node:test";
import {
  SiteAgentDataError,
  classifySiteAgentError,
  siteAgentClientErrorMessage,
} from "../lib/site-knowledge/errors.ts";

test("Site Agent client preserves actionable auth, permission, and resource errors", () => {
  assert.match(siteAgentClientErrorMessage(401, { error: "unauthorized" }), /登录状态已失效/);
  assert.match(siteAgentClientErrorMessage(403, { error: "site_agent_forbidden" }), /没有访问/);
  assert.match(siteAgentClientErrorMessage(404, { error: "site_agent_not_found" }), /找不到/);
  assert.match(siteAgentClientErrorMessage(503, { error: "site_agent_database_failed" }), /数据暂时不可用/);
  assert.match(siteAgentClientErrorMessage(0, undefined), /无法连接/);
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
    message: "网站 Agent 数据暂时不可用，请稍后重试；如持续出现请联系管理员。",
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
