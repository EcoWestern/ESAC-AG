# Where this stands, and what is left

A working note for whoever picks this up next, which is me. Delete it before the first release:
it describes a half-finished branch, not the suite.

## Right now

The work in the tree is **uncommitted and not green**: 59 of 64 tests pass. Nothing is broken in
a way that affects the released suite (`ESAC-GI`) or the program repository (`ESAC`), both of
which are clean and pushed.

Three commits landed today, all local, none pushed because you publish when v1 is done:

| Commit | What it is |
|---|---|
| `468b0f0` | The mock environment, the harness, and tool-call correctness |
| `2c817a8` | The sandbox, and five more categories |
| `c8a6f44` | Governance files |

Uncommitted: the judge, the ambiguity category, and the plumbing that goes with them.

## The five failing tests, and each cause

1. **`no item is passed by a run that does nothing`** gives the judged items a scripted judge
   that awards full marks, so the judged item scores 1 and the test fails. The premise was wrong:
   a judged item's score is the judge's, so a lenient judge legitimately passes a do-nothing run.
   Fix: use `createOracleJudge({ fractions: [0] })` for the judged branch and say in the comment
   that this proves the plumbing rather than the rubric.
2. **`a perfect run of every implemented category...`** and 3. **`no category is left
   unimplemented...`** both fail with `70.000001 !== 70`. Real defect, not a test problem: item
   points are rounded per item, and the ambiguity category's 5 points over 3 items give
   `1.666667` each, which sums to `5.000001`. Fix in `score.ts`: sum the unrounded
   `fraction * points` per category, then round once, and take the total from the rounded
   category sums.
4. **`the notes say what the number cannot be used for`** asserts the notes contain
   `INCOMPLETE`. With all seven categories implemented, a full run is now complete, so that note
   is correctly absent. Fix the assertion: require the "Nothing produced by this build is an
   ESAC-AG score" note and the modifier note, and move the `INCOMPLETE` claim into the
   partial-coverage test, which already covers it.
5. **`the report renders without throwing, and clamps its bars`** asserts `/INCOMPLETE/` on a
   complete run. Same cause. Fix: assert on the verdict line for the complete report, and keep
   the clamping assertion for the inflated report, which should now render as a failure.

## After those

- Update the docs for the judge: README (the judge, the `.env` route, the two new commands),
  `CHANGELOG.md` (0.3.0), and the program repository's `benchmarks/ag.md` plus its changelog.
  The status line already says "all seven categories implemented, no benchmark version,
  efficiency modifier not yet scored".
- Run `npm run verify` and `npm run esac -- selftest`, then commit.
- **Validate the judged path against the real judge.** Everything works against the scripted
  judge; the pinned one has never been called. This needs `OPENROUTER_API_KEY` in the
  environment or in a `.env` file: `npm run esac -- judge` reports whether it is set, and
  `npm run esac -- run --items ambiguity --model "oracle"` exercises the path with the real
  judge and no model spend.
- Then the two remaining items from the earlier list: the efficiency modifier's normalisation
  (envelopes anchored to the reference solutions' step counts), and the public and held-out pools.

## What I need from you

1. **`OPENROUTER_API_KEY`** in the environment or a `.env` file, when you want the judged path
   validated against the pinned judge rather than only against the scripted one. I will not read
   or echo the key.
2. **Nothing else.** `ESAC-AG` stays private until v1, as you said, so its rulesets stay as files.

## Settled, so nobody re-litigates it

- The judge is `xiaomi/mimo-v2.6-pro` over `https://openrouter.ai/api/v1`, the same pin as
  `ESAC-GI`, with the same 2x2 replication.
- `ESAC-GI` and `ESAC` have their rulesets applied. `ESAC-AG` cannot until it is public, which is
  deliberate.
- The sandbox fails closed, and its one documented hole is that Node cannot restrict network
  access per process.
