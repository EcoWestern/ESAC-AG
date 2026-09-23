# Contributing

## Pull requests are not accepted

This is the policy, not a preference, and it applies to everyone outside the organisation.

A benchmark score has to be traceable to a specific, trusted revision. If item generators,
graders, or scoring rules could change through an external merge path, then a number out of 75
would not reliably mean the same thing twice, and the suite would stop being an instrument. So
upstream pull requests are closed without review, by a workflow rather than by hand, with a
notice that explains why and points at the routes below.

A fork is the intended path for anyone who wants to change what the suite measures. The MIT
licence permits it. If you publish results from a fork, give the fork its own name and version
tag rather than labelling them ESAC-AG scores, and cite this repository as the origin.

## Issues are welcome, and read

Four templates exist, and the most useful of them is the item challenge:

- **Item challenge.** An item measures the wrong thing, is ambiguous, is not solvable, or has a
  payload that is realism theatre. An item is a generator rather than a stored question, so
  include the instance fingerprint from `esac inspect <itemId>`: it names the instance you saw.
- **Bug report.** The harness, the command line, a grader, or the sandbox does not do what it
  says. Include the sentence the harness gave you, because the wording is usually the clue.
- **Methodology question.** The specification does not settle something and you want to know why
  it is the way it is.
- **Security advisory**, for a way out of the sandbox or a seed leak. Privately, not in a public
  issue.

## Running it before reporting

Node 22.6 or newer, no runtime dependencies, no build step:

```bash
npm install
npm run verify            # typecheck, then the test suite, offline
npm run esac -- selftest  # the harness end to end, offline
npm run esac -- sandbox   # whether generated code can be run here, and why not
```

`npm run verify` is offline: no network, no API key, no model. If it fails on a clean checkout,
that is a bug report on its own and one of the more valuable ones.

## What a change has to clear

Not for outside contributors, since they do not land here, but stated so that the standard is
visible and can be argued with:

1. `npm run verify` passes, which includes the sandbox refusing what it claims to refuse.
2. Every item still ships a reference solution that passes its own hidden tests. An item whose
   tests nothing can pass measures nothing.
3. A category's point allocation and item count still match the specification. The bank refuses
   to run otherwise rather than producing a number nobody can audit.
4. No item is passable by doing nothing, and no check earns credit for a field the item is not
   about. Both are asserted in the test suite.
5. Anything the documentation claims about what exists is true of the code. The suite is
   unfinished on purpose, and the way to keep that honest is to keep the two in step.

## Held-out seeds

Held-out dataset seeds are evaluator-controlled and must never be committed, quoted in an issue,
or pasted into a transcript. If one leaks, that is a security advisory rather than a bug, because
the pool's usefulness is gone the moment it is public.
