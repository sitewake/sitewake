# Baseline

The numbers every later change is compared against. Each section names the
build, the model and the task-set version it was measured on; a new task-set
version starts a new baseline.

## Live demo, 2026-10-22 → 2026-10-27 (for comparison)

Not a benchmark run: the demo console's own records over the days the fixes
#40–#45 were made, read through the same attribution table
(`lib/capability-center-v2/failure-class.ts`). Model: `deepseek-v4-flash` from
10-26, `qwen3.7-plus` before.

**Generation tasks** — 74, of which 19 failed:

| Class · stage | Count |
| --- | --- |
| gate-false-reject · Validation | 5 |
| model-budget · Production | 4 |
| site-auth · Production | 3 |
| site-changed · Production | 2 |
| site-unreachable · Production | 2 |
| pipeline-contradiction · Production | 2 |
| model-protocol · Production | 1 |

**Visitor runs** — 100, of which 22 failed, 78 completed:

| Class · stage (code) | Count |
| --- | --- |
| unclassified · runtime.start (`agent_runtime_start_failed`) | 18 |
| wrong-answer · page-agent (`agent_incomplete`) | 2 |
| site-changed · runtime.stage (`capability_stage_select_option_missing`) | 2 |

The 18 start failures carry only the worded summary in the history list; the
cause stays in the run's kept evidence, which the attribution reads when a run
is written (not available to this after-the-fact pass). The driver logs of the
five-visitor checks on 10-26/27 showed two causes behind them: the runtime
refusing a page-bound capability the search had offered (`409
capability_scope_mismatch`, fixed by #45) and DeepSeek refusing a thinking
turn after a tool call (fixed by #44).

## Local benchmark, task set v1

_Filled in from the first two full runs on build `83a04847` (main after #45),
model `deepseek-v4-flash`._
