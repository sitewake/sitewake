import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Crawl jobs are dispatched only by leaseRunnerWork. If none of the resident worker
// roles in a deployment is on the dispatch list, jobs queue forever — the console just
// says "no runner is processing", no error, clean logs. This "nobody claims the queue"
// must be blocked structurally, not by someone remembering.

const readRepoFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Runner role → the queues it actually polls: see the consume calls in runner/browser-runner.ts. */
function queuesForRole(role) {
  if (role === "interactive") return ["interactive"];
  if (role === "author") return ["author"];
  if (role === "validate") return ["validate"];
  if (role === "background") return ["background"];
  return ["interactive", "background"]; // 未配角色时的默认双消费者
}

test("部署里至少有一个常驻 worker 能领采集任务", async () => {
  const compose = await readRepoFile("compose.yaml");
  const roles = [...compose.matchAll(/SITEWAKE_RUNNER_ROLE:\s*([a-z]+)/g)].map((m) => m[1]);
  assert.ok(roles.length > 0, "compose.yaml 里应能读到 runner 角色");

  const store = await readRepoFile("db/site-agent-store.ts");
  const gate = store.match(/const crawlRows = ([^\n]*)\n/)?.[1] || "";
  assert.ok(gate, "应能读到采集任务的派发条件");

  const leasesCrawl = (queue) => {
    if (/queue !== "interactive"/.test(gate)) return queue !== "interactive";
    return [...gate.matchAll(/queue === "([a-z]+)"/g)].some((m) => m[1] === queue);
  };

  const covered = roles.flatMap(queuesForRole).filter(leasesCrawl);
  assert.ok(
    covered.length > 0,
    `compose 里的角色 [${roles.join(", ")}] 对应队列 [${roles.flatMap(queuesForRole).join(", ")}]，`
      + `没有一个能领采集任务（派发条件：${gate.trim()}）。加角色或改派发条件，二选一。`,
  );
});

test("交互队列不领采集任务，避免占住用户当场操作的 runner", async () => {
  const store = await readRepoFile("db/site-agent-store.ts");
  const gate = store.match(/const crawlRows = ([^\n]*)\n/)?.[1] || "";
  assert.match(gate, /queue !== "interactive"/, "采集应排除交互队列");
});
