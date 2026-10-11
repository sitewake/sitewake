/**
 * The overview's cards read what their own buttons open.
 *
 * Each card on the overview carries a "查看全部 →" that opens a tab. Twice now a card
 * has been composed from a second, older source the tab does not read, and the two
 * views of the same site disagreed:
 *
 *   - 最近会话 read `overview.recentEpisodes`. An episode is one attempt at a task, not
 *     a session. sitewake.ai had eleven sessions and zero episodes, because its
 *     visitors are answered from site knowledge and nothing ever runs on the page, so
 *     the card sat on "等待第一个任务" under a heading that said recent sessions.
 *   - 可复用的能力 merged the Capability Center with the release's own `capabilities`.
 *     Both live sites happen to carry none in the release, so the card looked right —
 *     but nothing stopped the two lists from naming different capabilities.
 *
 * This is a source check rather than a render test because the property is about where
 * the data comes from, and that is a fact about the code, not about one fixture.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const OVERVIEW = await readFile(new URL("../components/console/living-overview.tsx", import.meta.url), "utf8");
const SESSIONS_TAB = await readFile(new URL("../components/console/session-history.tsx", import.meta.url), "utf8");

const endpoint = (source, pattern) => pattern.exec(source)?.[0] || "";

test("the recent sessions card reads the session history the sessions tab reads", () => {
  const card = endpoint(OVERVIEW, /\/api\/site-agents\/\$\{[^}]+\}\/session-history[^`]*/);
  const tab = endpoint(SESSIONS_TAB, /\/api\/site-agents\/\$\{[^}]+\}\/session-history[^`]*/);

  assert.ok(card, "the overview has to ask the session history for its rows");
  assert.ok(tab, "the sessions tab's own call has to still be findable");
  assert.match(card, /limit=3/, "three is what the card shows; asking for more is work nobody reads");
});

test("the recent sessions card no longer composes itself from episodes", () => {
  assert.doesNotMatch(OVERVIEW, /recentEpisodes/,
    "an episode is one attempt at a task; a site answered from knowledge has none and still has sessions");
  assert.doesNotMatch(OVERVIEW, /recentSessionEpisodes/,
    "grouping attempts into sessions was only needed while the card read episodes");
});

test("the capabilities card reads the Capability Center and nothing else", () => {
  assert.match(OVERVIEW, /\/api\/admin\/capability-v2\/capabilities/,
    "this is what the button beside the card opens");
  assert.doesNotMatch(OVERVIEW, /businessCapabilities/,
    "the release's own list is a second source the capabilities tab does not read");
});

test("both cards show the newest three, by their own ordering", () => {
  assert.equal((OVERVIEW.match(/\.slice\(0, 3\)/g) || []).length, 2, "both cards cap at three");
  assert.match(OVERVIEW, /Date\.parse\(right\.createdAt\)/,
    "three out of four has to be the three newest, whatever order the endpoint returns");
});
