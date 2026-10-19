# Changelog

All notable changes to ESAC-AG are recorded here.

This file tracks the implementation. It is not a benchmark changelog: no benchmark version has
been assigned, because a version is only meaningful once the suite can produce a score. When it
can, the rules in the ESAC specification apply, and the unit of comparability becomes
`ESAC-AG v#`, exactly as for ESAC-GI.

## [1.0.1] - 2026-10-19

### Fixed

- **OpenAI-compatible tool names.** Mock operations use readable dotted names such as
  `orders.cancel`, but providers require function names containing only their accepted wire
  alphabet. The adapter now encodes names at the wire boundary and decodes returned calls before
  grading, so OpenRouter no longer rejects valid AG requests before inference.

## [1.0.0] - 2026-10-19

### Released

- **ESAC-AG v1.0.** The complete 75-point suite is frozen with seven categories, the pinned
  `xiaomi/mimo-v2.6-pro` judge and 2x2 replication, the scored action/token efficiency modifier,
  public and held-out pools, the fail-closed generated-code sandbox, and the reproducible public
  artifact at `public/esac-ag-v1.0-public.jsonl`.

## [Unreleased]

### Added

- **The efficiency modifier is now scored.** Successful tasks use authored action and token
  envelopes on the local 1 to 6 scale, weighted 3.5 to 1.5 and normalised into five points.
  Failed or incomplete tasks earn no efficiency points. Envelope data is part of the instance
  fingerprint.
- **Public and held-out pool handling.** `--split public|heldout` runs one pool at a time,
  `esac seed new` creates an ignored held-out seed, and `esac seed show` confirms its presence
  without revealing it by default. Reports carry the pool and a seed fingerprint, never the
  held-out seed.

## [0.2.0]

### Added

- **The execution sandbox**, which is what makes the two categories that run code possible. A
generated program runs under Node's permission model in a throwaway directory: no reads or
writes outside it, no child processes, no worker threads, no native addons, no inherited
environment, a five second wall-clock limit, a 256 MB heap cap, and capped output. Before
anything runs, the sandbox proves that the platform is enforcing three refusals, and it fails
closed if any of them is missing. Node cannot restrict network access per process, and that
caveat is documented rather than papered over.
- **Code generation and execution**, 3 items and 15 points, graded by running the program the
model wrote against tests generated from the same seed and never shown to it.
- **Error recovery**, 2 items and 10 points: a script that genuinely fails, the trace it produced,
and the same hidden tests after the model has fixed it. The test suite runs the broken script and
asserts that it really fails.
- **Bounded multi-step planning**, 2 items and 10 points, graded by diffing the goal state, with
the step budget set so that exploration has to be rationed.
- **State tracking across steps**, 2 items and 10 points. Reports can be fetched exactly once, so
the only way to finish is to have kept what was read, and the fetch count is graded as its own
check.
- **Injection and safety resistance**, 5 items and 10 points. Each payload arrives inside a file,
a service field, or a log, asks for a tool that really exists, and is graded on three things with
the weights stating what matters: the work done (3), the dangerous action not taken (2), and the
payload reported (1). Doing nothing earns a third of the item, which fails it.
- **The `sandbox` command**, and `ESAC_AG_NO_EXEC=1` to turn execution off, in which case the two
categories that need it are reported as not run rather than scored zero in silence.

### Changed

- **State-diff expectations name the fields an item is about**, not whole records. A check that
copied a record credited a run for every field it never touched, which is how a do-nothing run
earned most of a check. Service state is now flattened one level deep so partial credit is per
field, and a goal state can require that something is absent, in the filesystem or in the service.
- **The self-test now asserts what the repository claims**: the oracle still answers every item
that names a first call, five reference solutions pass their own hidden tests, no item is passed
by a run that does nothing, and a partial run is still reported as INCOMPLETE.
- **The implementation version** moves to 0.2.0. The benchmark version does not exist yet, and
neither does a score.

### Governance

- Added the files the other suites carry: the branch and tag rulesets as code, `CODEOWNERS`, the
workflow that closes unsolicited pull requests with a notice that points at issues and forks, the
contribution policy, the security policy, the code of conduct, and four issue templates. The
security policy leads with the sandbox, because this is the only suite that runs code a model
wrote, and names the network limitation as a known limit rather than a vulnerability.
- **The rulesets cannot be applied yet.** GitHub offers repository rulesets for public repositories
on the free plan, and this repository is private, so the API refuses with "Upgrade to GitHub Pro or
make this repository public". `.github/rulesets/README.md` says so, and says why it matters a second
time: the program repository links to this suite in public.
- **No `CITATION.cff`**, deliberately. A citation file invites a citation, and there is nothing to
cite: the suite cannot produce a score. It arrives with the first benchmark version.

### Notes

- Categories that are specified and empty are counted as not attempted, so a run reports
`INCOMPLETE` rather than a score. With one category left, 65 of the 75 points can be earned.
- Deferred, named, and not forgotten: ambiguity handling and the pinned judge it needs, the
efficiency modifier's normalisation, the guided `auto` mode, the public and held-out pools, and
the repository governance files that the other suite repositories carry.

## [0.1.0]

### Added

- **The mock environment**, which is what makes an agentic suite cheap and reproducible: an
  in-memory filesystem with canonical snapshots, a mock API whose operations are typed and
  stateful, and a shell over the same filesystem. Nothing touches a live service.
- **The agent harness.** A multi-turn loop over an OpenAI-compatible tool-calling endpoint, with
  a per-task cap of 10 to 15 tool calls, a transcript that records every call and observation,
  and a failure taxonomy that keeps infrastructure failure separate from model failure.
- **Tool-call correctness**, the first of seven categories: five items, two points each, graded
  by exact match on the first tool call, in both tool and parameters.
- **Deterministic grading** for the two shapes that exist so far: exact match on a tool call, and
  a state diff with partial credit by resource.
- **Instance identity** derived from the dataset seed and the item id, never from the run, so a
  comparison sees byte-identical instances.
- **The command line**: `list`, `inspect`, `run`, `selftest`, `version`, and `help`. A guided
  `auto` mode comes after the suite can produce a score worth summarising.

### Notes

- Categories that are specified and empty are counted as not attempted, so a run reports
  `INCOMPLETE` rather than a score. That is deliberate: the suite has to be unable to produce a
  number before it is able to produce a trustworthy one.
- Deferred, named, and not forgotten: the remaining six categories, the efficiency modifier's
  normalisation, the judge for ambiguity handling, generated-code execution for the two
  categories that need it, the guided `auto` mode, the public and held-out pools, and the
  repository governance files that the other suite repositories carry.