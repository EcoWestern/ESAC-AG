# Changelog

All notable changes to ESAC-AG are recorded here.

This file tracks the implementation. It is not a benchmark changelog: no benchmark version has
been assigned, because a version is only meaningful once the suite can produce a score. When it
can, the rules in the ESAC specification apply, and the unit of comparability becomes
`ESAC-AG v#`, exactly as for ESAC-GI.

## [Unreleased]

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
