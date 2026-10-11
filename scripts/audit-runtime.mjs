// The production dependency audit, judged against the advisories this release
// has already accepted.
//
// `npm audit --omit=dev` alone cannot be a release gate: it fails on every
// advisory, including ones with no patched release, so the only way past it was
// to skip it — which is how a critical advisory sat in a release candidate while
// the gate was "known to fail at step one".
//
// This reads the audit and asks a narrower question: is every critical or high
// advisory either fixed or written down in security/accepted-advisories.json? An
// entry carries a review date, so an acceptance expires instead of quietly
// becoming permanent.
//
// npm reports one advisory once per node of the dependency path it travels, so a
// single finding six levels deep reads as six findings. Comparing advisory ids
// rather than counts is what keeps the two from being confused.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACCEPTED_PATH = "security/accepted-advisories.json";
const BLOCKING = new Set(["critical", "high"]);

function runAudit() {
  // npm audit exits non-zero whenever it finds anything, so the exit code says
  // nothing we want; the JSON is the answer. A missing or unparseable body is a
  // real failure, because then we do not know what is in the tree.
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (!result.stdout) {
    throw new Error(`npm audit produced no output${result.stderr ? `: ${result.stderr.trim().slice(0, 400)}` : ""}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit output is not JSON: ${result.stdout.slice(0, 300)}`);
  }
}

/** One record per distinct advisory, regardless of how many paths reach it. */
export function advisoriesFrom(audit) {
  const byId = new Map();
  for (const vulnerability of Object.values(audit.vulnerabilities || {})) {
    for (const via of vulnerability.via || []) {
      // A string `via` is the name of the package below this one in the path —
      // the same advisory, one node further up. Only the object carries it.
      if (typeof via !== "object") continue;
      const id = via.url?.split("/").pop() || String(via.source);
      if (!byId.has(id)) {
        byId.set(id, { id, package: via.name, severity: via.severity, title: via.title, range: via.range });
      }
    }
  }
  return [...byId.values()];
}

export function readAccepted(root = ROOT) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(`${root}${ACCEPTED_PATH}`, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`${ACCEPTED_PATH} is not readable: ${error.message}`);
  }
  const entries = parsed?.accepted;
  if (!Array.isArray(entries)) throw new Error(`${ACCEPTED_PATH} must hold an "accepted" array`);
  return entries;
}

/**
 * The verdict, as data, so a test can reach it without running npm.
 *
 * `today` is a parameter because an acceptance expiring is the behaviour most
 * worth testing, and waiting for a date to pass is not a test.
 */
export function judge(advisories, accepted, today = new Date()) {
  const byId = new Map(accepted.map((entry) => [entry.id, entry]));
  const unlisted = [];
  const expired = [];
  const incomplete = [];

  for (const advisory of advisories) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const entry = byId.get(advisory.id);
    if (!entry) { unlisted.push(advisory); continue; }
    const reviewBy = Date.parse(entry.reviewBy || "");
    if (!Number.isFinite(reviewBy)) {
      incomplete.push({ ...advisory, why: "reviewBy is missing or not a date" });
      continue;
    }
    if (reviewBy < today.getTime()) expired.push({ ...advisory, reviewBy: entry.reviewBy });
    for (const field of ["callSurface", "mitigation", "noFixExists"]) {
      if (!entry[field] || (Array.isArray(entry[field]) && !entry[field].length)) {
        incomplete.push({ ...advisory, why: `${field} is empty` });
      }
    }
  }

  // An acceptance for something no longer in the tree is stale: it should be
  // deleted, or it will be read as still carrying weight.
  const present = new Set(advisories.map((advisory) => advisory.id));
  const stale = accepted.filter((entry) => !present.has(entry.id)).map((entry) => entry.id);

  return { unlisted, expired, incomplete, stale, blocking: unlisted.length + expired.length + incomplete.length };
}

function report(verdict, advisories) {
  const blocking = advisories.filter((advisory) => BLOCKING.has(advisory.severity));
  console.log(`production dependencies: ${advisories.length} advisories, ${blocking.length} critical or high`);

  for (const advisory of verdict.unlisted) {
    console.error(`\nNOT ACCEPTED  ${advisory.id}  ${advisory.severity}  ${advisory.package} ${advisory.range}`);
    console.error(`  ${advisory.title}`);
    console.error(`  Upgrade it, or record it in ${ACCEPTED_PATH} with its call surface, mitigation and a review date.`);
  }
  for (const advisory of verdict.expired) {
    console.error(`\nACCEPTANCE EXPIRED  ${advisory.id}  review date ${advisory.reviewBy} has passed`);
    console.error(`  Re-check whether a patched release exists and whether the call surface still holds, then set a new date.`);
  }
  for (const advisory of verdict.incomplete) {
    console.error(`\nACCEPTANCE INCOMPLETE  ${advisory.id}  ${advisory.why}`);
  }
  if (verdict.stale.length) {
    console.log(`\nstale acceptances, no longer in the tree (delete them): ${verdict.stale.join(", ")}`);
  }
  if (!verdict.blocking) console.log("every critical or high advisory is either fixed or accepted on record");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const audit = runAudit();
    const advisories = advisoriesFrom(audit);
    const verdict = judge(advisories, readAccepted());
    report(verdict, advisories);
    process.exit(verdict.blocking ? 1 : 0);
  } catch (error) {
    console.error(`audit:runtime could not reach a verdict: ${error.message}`);
    process.exit(1);
  }
}
