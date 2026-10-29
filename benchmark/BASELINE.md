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

## Iteration 3 — validation cases come from the list the demonstrated value was chosen from

Measured on build `f3c6566b` (iteration 2 plus the first two changes
below), run `2026-10-28T11-36-16`, re-judged with the current checker.

- The case harvest scored product cards and penalised navigation, so the
  category list "Poetry" sits in never became a region; the cases for the
  category input were drawn from the first card instead. The harvest now
  keeps, ahead of everything else, the list each demonstrated value is found
  in, as the page lays it out (`choice-list`), the derivation takes that
  list's other items as the cases, and the suggestions beside the
  demonstration are that list and nothing else.
- The demonstrated case finding nothing fails validation when the visitor's
  run found a result.
- After the run: of the lists that show the value, the one with the most
  choices (on a category page the breadcrumb also names the category, and
  came first: the cases were "Home" and "Books"); a case that finds nothing
  for a value the site lists beside the demonstrated one is a failed case and
  the floor rejects on it; a link that turns the page is a control, not the
  object acted on.

| Rate | Iteration 2 (`e7ccffa9`) | Iteration 3 (`f3c6566b`) |
| --- | --- | --- |
| First ask | 14 / 18 (77.8%) | 15 / 18 (83.3%) |
| Generation published | 1 / 9 (11.1%) | 3 / 9 (33.3%) |
| Reuse | 1 / 1 | 0 / 2 |
| Failures by class | gate-false-reject 4 · contradiction 3 · wrong-answer 3 · timeout 2 · model-protocol 1 | wrong-answer 4 · gate-false-reject 2 · contradiction 2 · timeout 2 · site-changed 1 · model-budget 1 |

Published: `books-count-poetry` (its cases now "Travel", "Mystery", …),
`books-price-named` (cases "Tipping the Velvet", "Soumission" — titles from
the same list; all three passed), `ps-category-count`. The two reuse
failures are the same defect: each published program opens the demonstrated
category whatever the input, and its validation had seen it find nothing
for the other categories and called that a result. The rule made after the
run refuses exactly that; it turns those two publications into rejections
with the reason named, and leaves the reuse ask to the page agent.
`books-most-expensive-travel` was refused on its own Contract: a success
condition `textIncludes "results."` written from the demonstrated page's
wording, which the pages the cases reached do not carry — the next class on
books. PrestaShop generations ended as in iteration 2 (two authoring budgets
spent on the cart modal, one ambiguous target); `quotes-tag-count` ended on a
page turn renamed as the acted-on object (fixed after the run, above);
`quotes-by-author` spent 48 tool calls without writing a draft.

**The iteration's head** (`f1f75a3e`, run `2026-10-28T12-54-49`, with the
three changes made after the first run): first ask 14 / 18, generation
2 / 12, reuse 1 / 1. `books-count-poetry` validated on Poetry, Travel and
Mystery — all three passed — and its reuse ask for Mystery was answered
through the capability in 19 s, the first reuse on books that a published
program answered correctly. `books-price-named` validated on three titles
from the same list. `ps-category-count`, which the first run had published
to answer every category with the demonstrated one, was refused with the
reason named (`no_result_for_offered_input:category="CLOTHES"`): the rate
counts it as a loss, the visitor is better off. The denominator grew to 12
because every passing first ask left a finished run record this time; the
other nine ended on the classes already listed — the Contract's
`textIncludes "results."` (`books-cheapest-travel`), the cart modal's wait
and the authoring budget on PrestaShop, an ambiguous target, a page turn
(the fix for it is in this head but `quotes-tag-count` failed three drafts
on a different identity check), and `quotes-by-author`.

**First-ask failures across the two runs** come from the page agent, not
the module: `books-five-star-mystery` (one page of two, every run),
`ps-search-count` (answered from the index), `books-cheapest-travel` (a
different book), `ps-add-notebook-zh` (added nothing). They cap the visitor
rate below 90% whatever the module does, and are the other half of the work.

## Reduced pipeline — recording, authoring, validation

Measured on build `143899d3` (the benchmark driver at `59da2da5`), run
`2026-10-28T23-14-20`. The pipeline is the three steps that carry evidence:
the recording is the trace and states the Contract, authoring replays the
draft on the demonstrated input and on the values the start page lists
beside it, validation decides publication by its own record, and one repair
follows a rejection that names a case. The explorer, the parameter planner,
the contract designer, the case enrichment and the model review are gone;
45 checks with no recorded defect behind them are notes.

| Rate | Iteration 3 head (`f1f75a3e`) | Reduced (`143899d3`) |
| --- | --- | --- |
| First ask | 14 / 18 (77.8%) | 15 / 18 (83.3%) |
| Generation published | 2 / 12 (16.7%) | 3 / 10 (30%) |
| Reuse | 1 / 1 | 2 / 2 |
| Visitor (first + reuse) | 15 / 19 (78.9%) | 17 / 20 (85%) |
| Generation, median time followed | 493 s | 100 s |
| Generation, median model calls | not recorded | 22 |

Every books generation published, in 70–80 s and 7–14 model calls:
`books-cheapest-travel` (refused in every earlier run on the Contract's
`textIncludes "results."`), `books-count-poetry`, `books-price-named`; both
reuse asks were answered through the published programs. No rate fell; the
two first-ask regressions (`ps-open-detail-price`, `quotes-tag-count`) are
page-agent answers, outside the pipeline.

What is left, by class:

- **Authoring on PrestaShop and quotes** (5): the cart modal and the
  quantity control (`ps-add-cushion` 47 calls, `ps-add-mug-quantity`
  control-flow timeout, `ps-add-notebook-zh` the same failure twice,
  `ps-cheapest-accessory` 46 calls) and `quotes-by-author` (46 calls). The
  budget is spent inside the loop, now without a model turn anywhere else.
- **A demonstration with no actions** (`ps-category-count`): the visitor
  opened the Art category page and read it, so the recording has no step to
  author from (`capability_recording_without_actions`). A read-only
  demonstration needs a trace that opens the page for the input.
- **Intake matched the wrong capability** (`books-most-expensive-travel`):
  the classification took "most expensive" for the published "cheapest" and
  created no generation.

## Iteration 5 — the defects the reduced pipeline's records showed

Measured on build `bd07bb7e`, run `2026-10-29T02-08-38`, against the
reduced pipeline (`143899d3`, run `2026-10-28T23-14-20`). Every change below
came from a failed task's own records.

- The seed's control selector had unquoted attribute values with spaces:
  every seed that acted by a click threw before the model wrote a line.
- The model, fixing it, doubled the backslashes of a regex and sent the
  same edit thirty times. An edit is found through runs of backslashes and
  whitespace when that names one place; a miss shows the closest lines; the
  third unchanged repeat ends the loop.
- After an add to cart the runner went back in history (PrestaShop disables
  the button while its confirmation is open), so the verify stage ran on
  `about:blank`. That recovery now runs only before anything is written.
- The trace binds a quantity typed as "2" to the numeric input; opens from
  the home page by the input's link when the run began on the page the input
  chooses (`/9-art`, `/6-accessories`), which gives a read-only demonstration
  a trace; finds a link named alike in every entry ("(about)") by the entry
  that names the input; and drops what came before a return by the back
  button.
- The duplicate check is told that a different selection criterion is a
  different capability ("most expensive" is not "cheapest").
- Validation rejects a case that failed in any way on a value the site lists,
  not only one that found nothing (two programs that timed out on every other
  category had been published); the harvest names list items by their
  document text, not as CSS draws them ("CLOTHES"); a generation that adds an
  input to a name already live or in flight is named for what it adds
  ("Add product to cart (with quantity)").

| Rate | Reduced (`143899d3`) | Iteration 5 (`bd07bb7e`) |
| --- | --- | --- |
| First ask | 15 / 18 | 15 / 18 |
| Generation published | 3 / 10 | 6 / 9 |
| Reuse | 2 / 2 | 5 / 5 |
| Visitor (first + reuse) | 17 / 20 (85%) | 20 / 23 (87%) |
| Generation, median | 100 s | 196 s, 14 model calls |

Published and correct on reuse with a value other than the demonstrated one:
the three books capabilities, `ps-add-cushion` (the Mountain fox cushion),
`ps-add-mug-quantity` (three mugs, under its own name) and
`ps-open-detail-price`. `books-most-expensive-travel` and
`ps-add-notebook-zh` were answered on the first ask through a published
capability, so nothing was generated.

An intermediate run (`fa633ecf`, run `2026-10-29T01-13-58`) published 9 of
10 but three of those answered wrong on reuse (5 / 8): the category count
and the cheapest item had timed out on every other category during
validation, and the mug's capability had been set aside for the cushion's.
The last three fixes above are for those; this run refuses the category
count instead of publishing it.

What is left: `ps-category-count` (authoring repeats a failure on the other
categories), `quotes-tag-count` and `quotes-by-author` (authoring budget),
and three first asks the page agent answers wrong (`books-five-star-mystery`,
`ps-search-count`, `ps-search-no-result`).

## Iteration 6 — two runs of one build

Build `5960b17b`, runs `2026-10-29T03-49-01` and `2026-10-29T04-26-25`,
back to back on the same stack, so the comparison separates what is
unstable from what changed.

- The widget never moves the run's revision back on a late response, and
  its final update reconciles once on a conflict: runs had stayed "running"
  with the visitor's answer lost (`ps-search-no-result`).
- An action whose tool name the model left out (`{"index": 12}`) is named
  as a click when that is the only tool it fits.
- Icon-font glyphs (private-use characters) are no part of a name: the
  harvest had offered "\ue313 \ue316 Clothes" as a category.
- A run that reached the input's page by its address, without a click, is
  opened by the input's link; the author is told innerText carries CSS case.

| Rate | Iteration 5 (`bd07bb7e`) | Iteration 6, run 1 | Iteration 6, run 2 |
| --- | --- | --- | --- |
| First ask | 15 / 18 | 15 / 18 | 16 / 18 |
| Generation published | 6 / 9 | 8 / 10 | 10 / 13 |
| Reuse | 5 / 5 | 6 / 7 | 7 / 8 |
| Visitor | 20 / 23 | 21 / 25 | 23 / 26 |

Across both runs: generation 18 / 23 (78%), reuse 13 / 15, first ask
31 / 36, visitor 44 / 51 (86%). Five tasks flipped between the two runs of
one build (two PrestaShop generations, a quotes generation, a reuse, a
first ask), so one run moves a rate by about two tasks.

What is left, by class:

- **Counts across several pages**: `quotes-tag-count` was published and
  answered another tag wrong on reuse, and the page agent misses the same
  count on first asks (`books-five-star-mystery`, `quotes-tag-count`).
- **The page agent building a search address** (`/search?q=…`) instead of
  using the site's search box (`ps-search-count`, every run).
- **A capability that times out for a value off the page it was shown on**
  (`ps-open-detail-price` reuse, `ps-add-notebook-zh` through the mug's
  capability).
- Model variance in authoring: budgets and malformed actions, one or two
  tasks a run.

## Iteration 8 — values from the whole list, not only the start page

Found on the demo console (`demo-console.sitewake.ai`, 2026-10-29): "Get
product price", generated from a visitor who picked the Mira Pendant on the
home page, was validated on three other home-page lamps and hung for three
minutes on the Pilo Mushroom Lamp, which the home page does not show (four
of sixteen lamps are there).

- The harvest recognises a grid of cards as a list, named by each card's
  heading; a title the card cuts short is taken from its link's full title or
  left out.
- It reads a bounded few pages linked from the start page; a list there that
  holds every value the start page shows, and more, is the one replays and
  cases come from, the unseen values first.
- When the input's whole list is on such a page and the trace starts by
  clicking the item the input names, the program starts there and is
  published with it as its entry.
- A target chosen by an input that the settled page does not show ends the
  wait in seconds; the seeded stage answers that there is no such item.
- An output another listed value answers without is optional; a number the
  answer adds in parentheses is not what it found.

Reproduced against the live demo shop with the server's own RunSpec and
`deepseek-v4-flash`: the program starts on `/shop`, and answers Pilo ($119,
out of stock), Fenna ($129) and Mira ($219); a lamp the shop does not sell
fails in 12 s instead of 3 min.

| Rate | Iteration 6 (two runs) | Iteration 8, run `2026-10-29T08-05-33` (`8848d2d2`) |
| --- | --- | --- |
| First ask | 31 / 36 | 17 / 18 |
| Generation published | 18 / 23 | 6 / 11 (6 / 9 that started) |
| Reuse | 13 / 15 | 5 / 5 |

Two intermediate runs on this branch (`2026-10-29T06-30-19`,
`2026-10-29T07-22-34`) published 7 / 11 and 7 / 10 and showed what the wider
lists broke first: a PrestaShop program moved to a page that was larger but
not a superset of the home page's list, a colour field required of products
without colours, and cut card titles used as cases; each is fixed above. The
wider values make PrestaShop authoring harder (the cushion's cases now
include mugs), and generation on this benchmark is lower than iteration 6;
no published capability failed on reuse in any of the three runs.

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
