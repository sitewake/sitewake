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

## Iteration 1 — build `9faf423f`, run `2026-10-28T07-59-08`

The four refusals the baseline ranked first (benchmark/GATES.md, commit
`9faf423f`): the `.html` detail-transition guard scoped, the explorer's
element-less `extract` taken as the demonstration's end, a colour word inside
a product's own name no longer a facet to ground, the output-provenance check
demoted to a note.

| Rate | Baseline run 2 (v2) | Iteration 1 |
| --- | --- | --- |
| First ask | 15 / 18 (83.3%) | 15 / 18 (83.3%) |
| Generation published | 0 / 14 (0%) | 3 / 12 (25%) |
| Reuse | 0 / 0 | 1 / 2 (50%) |

Published: `books-price-named`, `ps-category-count`, `ps-cheapest-accessory`
(whose reuse ask, the cheapest item in Clothes, passed through the published
capability — the first reuse the benchmark has seen). `ps-category-count`'s
reuse answered the wrong count. No rate fell; `books-cheapest-travel-zh`
flipped to a wrong answer, as its English twin had flipped between the two
baseline runs.

What still ended generations, from the console's records: the detail-transition
guard, three times, because the authoring manifest marks every clicking stage
as a write (demoted to a receipt note in `d38922de`); a budget spent before
any draft ran, twice; a wait that never settled in a PrestaShop add-to-cart
draft, twice; a review that rejected `books-count-poetry` on two validation
cases whose inputs — "In stock", "Tipping the Velvet" — were never categories;
a validation that produced no result for `ps-open-detail-price`. The last two
are the next class: validation cases drawn from page text that is not a value
of the input's kind.

## Iteration 1, second step — build `d38922de`, run `2026-10-28T08-52-20`

The detail-transition guard demoted from an ended run to a note on the stage
receipt (it had ended three generations in the first step because the
authoring manifest marks every clicking stage as a write), and the five
demo-shaped authoring hints replaced by one site-neutral hint.

| Rate | Baseline run 2 (v2) | Iteration 1 (`9faf423f`) | Second step (`d38922de`) |
| --- | --- | --- | --- |
| First ask | 15 / 18 (83.3%) | 15 / 18 (83.3%) | 16 / 18 (88.9%) |
| Generation published | 0 / 14 (0%) | 3 / 12 (25%) | 2 / 9 (22.2%) |
| Reuse | 0 / 0 | 1 / 2 (50%) | 0 / 2 (0%) |
| Failures by class | contradiction 3 · budget 6 · site 5 | gate-false-reject 4 · navigation-lost 3 · timeout 3 · wrong-answer 3 | gate-false-reject 5 · wrong-answer 3 · site-changed 2 · contradiction 1 |

Against the baseline no rate fell, `pipeline-contradiction` went 3 → 1 and
`navigation-lost` stayed at 0 (3 → 0 against iteration 1). Against iteration 1
the compare flags generation and reuse as lower; read task by task, two
generations flipped to published (`ps-add-cushion`, which the first step ended
on a wait that never settled; `quotes-tag-count`, which it ended on the
guard), none flipped to failed, and the three the first step had published
were never attempted: the run began with those capabilities still live, so
their first asks were answered through them and left no demonstration. Those
three records are left out of the generation denominator (the `report.v2`
beside the run is the re-judged one), and from this commit on a run disables
the live capabilities of its sites before it starts. `gate-false-reject` did
not fall (4 → 5): the three guard refusals are gone and five different
refusals took their place (below), so the second step does not meet its own
bar on that class.

**Reuse 0 / 2 — both published programs ran and returned a wrong result.**
"Count quotes by tag" asked for `life` answered 3 quotes on 3 pages (the tag
has 13 on 2 pages); "Add product to cart" asked for the Mountain fox cushion
walked nine pages and ended with "cart has no row matching". Both had passed
validation, which checked that a result of the right shape came back, not
that it was the page's own count or the cart's own row. That is a class of
its own: a read capability's validation never compares the program's number
with the count the page states.

**What ended the seven generations**, from the console's records:

| Cause | Attempts | Class |
| --- | --- | --- |
| `draft_business_outcome` — the draft reached the right category page (`…/poetry_23/`) and its own verify stage then declared "category page does not match the requested category"; three attempts, the same code each time (`books-count-poetry`, `books-most-expensive-travel`) | 2 | gate-false-reject |
| `capability_module_target_first_candidate_forbidden` — the module check forbidding "first similar candidate" target resolution rejected every attempt; before it, the contract step had refused the demonstration's end on the product page as "completion evidence missing" because the address did not carry `action` (`ps-add-mug-quantity`) | 1 | gate-false-reject |
| `capability_control_flow_timeout` at the verify stage waiting for quote cards on an author page that has none, then `required_input_does_not_parameterize`, then the budget (`quotes-by-author`) | 1 | gate-false-reject |
| review `Rejected` (`books-cheapest-travel-zh`) | 1 | gate-false-reject |
| `page_changed` ← `locator_not_found:step_1` — the replay could not find the demonstration's first element (`books-cheapest-travel`) | 1 | site-changed |
| `target_ambiguous:step_1:scope` (`ps-open-detail-price`) | 1 | site-changed |
| no run record for a first ask the page agent answered (`ps-search-count`), so no generation could be followed | 1 | pipeline-contradiction |

**First-ask failures:** `ps-search-count` (the count missing from the
reply), `ps-add-notebook-zh` (the agent added twice — two cart rows where the
task expects one; unstable since the baseline).

## Iteration 2 — what the demonstration established reaches the program

Measured on build `e7ccffa9`, run `2026-10-28T10-45-48` (re-judged with the
checker of this commit, which lets a title drop its subtitle as the page
does when it cuts the title short). The fixes, each traced to a recorded
failure and reproduced before it was made:

- a stage that clicks and unloads its document could not return its state,
  so the acted-on identity the seed had read was lost and the verify stage
  refused the right category page three times per generation — a stage now
  keeps that state before the action (`keep`) and both hosts take it as the
  stage's state when the return never arrives;
- the authoring loop never read a draft's output against what the visitor
  was told: "Count quotes by tag" was proven with twelve quotes, counted the
  two on its last page and was published — the experience carries the
  answer, and a draft whose output states none of the numbers the answer
  leads with goes back to the model with both texts;
- a scope written with a wildcard segment was opened as the capability's
  entry address (the site answered with its index);
- a run id whose last digits pass the card-number check came out of the
  experience's redaction as `run_…93c[REDACTED]`, never equalled the
  authority's run id, and the intake retried the visitor's successful run
  for hours without generating from it — identifiers are never redacted;
- a card title cut with an ellipsis names the same book as the page's full
  title; and a product card's image link, found by its image's alt, is named
  by what found it (`nameOf`) rather than read as an empty `innerText` — the
  last of these was made after the run, on a replay of the run's own failed
  draft, which then succeeds.

| Rate | Second step (`d38922de`) | Iteration 2 (`e7ccffa9`) |
| --- | --- | --- |
| First ask | 16 / 18 (88.9%) | 14 / 18 (77.8%) |
| Generation published | 2 / 9 (22.2%) | 1 / 9 (11.1%) |
| Reuse | 0 / 2 | 1 / 1 |
| Failures by class | gate-false-reject 5 · wrong-answer 3 · site-changed 2 · contradiction 1 | gate-false-reject 4 · contradiction 3 · wrong-answer 3 · timeout 2 · model-protocol 1 |

Read by rate, both visitor rates fell. Read by task, no first ask that
depends on the module changed: the four first-ask failures are the page
agent reading one page of a two-page listing (`books-five-star-mystery`,
failed in every run since the second step), the assistant answering a live
count from the crawl index (`ps-search-count`, 4 mugs indexed, 5 on the
storefront), a run answered through a capability the benchmark had just
reported retiring (`quotes-tag-count` — the console deletes only a disabled
capability, and the retire step took the refusal for success; fixed in this
branch), and `quotes-by-author` ending in no result. Three first asks that
passed in front of the visitor left no run record: the widget's final update
was refused twice with 409 (`agent_run_revision_conflict`) and the run stayed
`running`, so no generation followed (`ps-category-count` among them). That
is a class of its own for the next iteration.

**Generation 1 / 9.** On books, `books-count-poetry` and
`books-cheapest-travel` were rejected on validation cases drawn from a
product card — "In stock", "Tipping the Velvet" as categories — the class
iteration 3 takes on; `books-price-named` failed on the empty identity of
an image link (fixed after the run, above); `books-most-expensive-travel`
published and its reuse passed through the capability. On PrestaShop none
published: a stage declared `navigation: "required"` that never navigates,
three times (`ps-cheapest-accessory`); a verify stage waiting for
`#blockcart-modal .product-name` that never shows (`ps-add-mug-quantity`,
`ps-add-notebook-zh`); a state read the manifest did not declare, twice,
after a write it did not declare (`ps-add-cushion`); a validation that
produced no result (`ps-open-detail-price`).

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
