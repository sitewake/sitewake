# Baseline

The numbers every later change is compared against. Each section names the
build, the model and the task-set version it was measured on; a new task-set
version starts a new baseline.

## Local benchmark, build `83a04847` (main after #45), model deepseek-v4-flash

Two full runs of task set v1 (21 tasks), 2026-10-28 06:08 and 06:54, re-judged
with the checker and attribution of commit `9e1448bb` and read as task set v2
(saucedemo's three asks left out — `report.v2.md` beside each run's original):

| Rate | Run 1 (`2026-10-28T06-08-21`) | Run 2 (`2026-10-28T06-54-07`) |
| --- | --- | --- |
| First ask | 14 / 18 (77.8%) | 15 / 18 (83.3%) |
| Generation published | 0 / 11 (0%) | 0 / 14 (0%) |
| Reuse | 0 / 0 | 0 / 0 |
| Visitor (first + reuse) | 14 / 18 (77.8%) | 15 / 18 (83.3%) |

As run (v1, 21 tasks, original checker): first ask 12/21 and 14/21; the three
saucedemo asks failed both times because the page agent will not type the
login shown on the page (a policy, not a defect — the site is retired in v2);
two verdicts per run were the checker's own fault (a price written `$11.90`
against the fact `11.9`; a title without its series suffix) and are corrected
in the v2 reading.

**Unstable between the two runs** (same build): `books-cheapest-travel`,
`books-most-expensive-travel`, `ps-open-detail-price`, `ps-add-notebook-zh` —
each passed once and failed once on the first ask (wrong answer, a step limit,
a model turn the gateway refused). Their generation attempts differ between
the runs accordingly.

**Generation: 0 published of 25 attempts.** The console's task records name
the cause behind each wrapper code:

| Cause (what the loop stopped on) | Attempts | Class |
| --- | --- | --- |
| `capability_stage_related_target_navigation` — the runtime treats any `.html` → other `.html` page as a product-detail detour; paging a tag or category trips it | 6 | gate-false-reject |
| `page_changed` ← `exploration_element_invalid` — the explorer answered `extract` for a value visible on the page (a result count) with no element index, and the run was ended instead of finished | 6 | model-protocol (explorer contract) |
| `capability_module_output_provenance_unknown` — the verify stage's output was computed from a list of elements (the cheapest of them); the provenance resolver cannot trace it and fails closed | 3 | gate-false-reject |
| `capability_goal_target_not_grounded` — the contract step refused the goal's product although the run had just added it to the cart | 3 | gate-false-reject |
| `draft_business_outcome` — the draft replay ended in NoResult/BusinessRejection | 2 | gate-false-reject |
| `capability_control_flow_timeout` — a wait in a draft never settled | 2 | timeout |
| not generated — the run ended with no result, or never left its first page | 3 | (expected; not counted from `9e1448bb` on) |

Eighteen of the twenty-five are the pipeline refusing or mishandling a run that
had just succeeded in front of the visitor. That is where iteration 1 starts.

**First-ask failures (v2 view, both runs):** a wrong answer from the page agent
(`ps-search-count` twice: it navigated to a guessed `/search?q=` instead of
using the search box; `books-cheapest-travel` once), a step limit
(`ps-open-detail-price`), a model turn refused by the gateway
(`ps-add-notebook-zh`, `page_agent_model_failed`), and a run the widget ended
that the console never recorded (`books-five-star-mystery`: 209 s, no run
record).

## Live demo, 2026-10-22 → 2026-10-27 (for comparison)

Not a benchmark run: the demo console's own records over the days the fixes
#40–#45 were made, read through the same attribution table. Model:
`deepseek-v4-flash` from 10-26, `qwen3.7-plus` before.

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
capability_scope_mismatch`, fixed by #45) and DeepSeek refusing a thinking turn
after a tool call (fixed by #44).
