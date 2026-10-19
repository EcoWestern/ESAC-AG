# ESAC-AG

**Agentic Work and Capability. ESAC-AG v1.0.0.**

> **Status: released.** All seven categories have items, the efficiency modifier is scored, and
> the public artifact is reproducible. Scores are comparable only as `ESAC-AG v1.0` results and
> only when produced with the pinned judge and the documented protocol.
>
> The specification is the authority, not this repository:
> [constitution §6](https://github.com/EcoWestern/ESAC/blob/main/specs/constitution.md) and
> [amendment 001 §1](https://github.com/EcoWestern/ESAC/blob/main/specs/amendments/001-first-amendment.md).

ESAC-AG measures work performed across turns against an environment: choosing tools, planning
under a budget, writing code that has to run, recovering from failure, tracking state, handling
ambiguity, and resisting instructions that arrive inside tool output rather than from the user.

## What exists

| Category | Points | Status |
|---|---:|---|
| Tool-call correctness | 10 | **implemented**: 5 items, exact match on the first call |
| Bounded multi-step planning | 10 | **implemented**: 2 items, goal state reached inside a tight budget |
| Code generation and execution | 15 | **implemented**: 3 items, hidden tests run against the program |
| Error recovery | 10 | **implemented**: 2 items, a broken script, its trace, and the same hidden tests |
| State tracking across steps | 10 | **implemented**: 2 items, values that can only be fetched once |
| Ambiguity handling | 5 | **implemented**: 3 items, pinned judge with 2x2 replication |
| Injection and safety resistance | 10 | **implemented**: 5 items, an instruction in the data and a dangerous tool it wants |
| Efficiency modifier | 5 | **implemented**: authored action and token envelopes |

## The mock environment

Every task runs against a small environment that is deterministic, redistributable, and entirely
in memory. It never touches a live service, which is what makes a run cost the same every time
and reproduce exactly from this repository alone.

- **Filesystem.** A toy tree of files and directories, with read, write, append, list, make,
  move, and remove, and a canonical snapshot that can be diffed.
- **API.** A mock service with canned and state-machine responses. Operations have typed
  parameters, and the wrong operation is a plausible mistake rather than a random one: cancelling
  an order and refunding it are different tools with different effects.
- **Shell.** A small command surface over the same filesystem, so a task can be solved with
  commands instead of file-by-file edits.
- **Turn budget.** Each task carries its own cap of 10 to 15 tool calls. Reaching it ends the run
  as a failure, so no item can quietly become a long-running loop.

## Running it

Node 22.6 or newer, no runtime dependencies, no build step:

```bash
npm install
npm run verify                      # typecheck, then the test suite, offline
npm run esac -- list                # the item bank and point allocation
npm run esac -- inspect <itemId>    # one generated instance, with its checks
npm run esac -- sandbox             # whether generated code can be run here, and why not
npm run esac -- selftest            # the harness end to end, offline
npm run public:verify                # public artifact is reproducible
npm run esac -- run --model oracle  # a full run with the oracle, which measures nothing
```

`--model` takes `oracle` for a dry run, or an OpenAI-compatible adapter spec of the form
`<baseUrl>|<model>|<apiKeyEnvVar>`. Tool calling is used, so the endpoint has to support it.
Setting `ESAC_AG_NO_EXEC=1` turns code execution off; the two categories that need it are then
reported as not run rather than scored zero quietly.

## Running generated code

Two categories, code generation and error recovery, are graded by running a program the model
wrote. That is the only part of this repository that executes anything, so the design starts
from what the child process is unable to do rather than from what it is asked to do.

Before anything is executed, the sandbox proves that the platform is enforcing: it writes a file
it is allowed to write, fails to read a file outside its directory, and fails to start a process.
If any of those three behaves differently, nothing runs and the tasks that need execution are
reported as not run. **It fails closed**, which matters more here than any of the individual
limits:

- reads and writes are confined to one throwaway directory that is deleted afterwards;
- starting a process, a worker thread, or a native addon is refused by the runtime;
- the environment is built from nothing, so no key, token, or proxy setting is inherited;
- a wall-clock limit, a heap cap, and an output cap are applied to every run.

Two caveats, stated rather than implied. Node's permission model does not restrict network
access, because there is no per-process network permission to set, so a program could open a
socket; the environment it is given holds no secret and the tasks are offline by construction,
which is why being careful about what gets passed in matters more than what could get out. And
these are limits enforced by Node and by the parent process, not an operating system container.

## Design notes

- **Instance identity depends on the dataset seed and the item id, never on the run**, so every
  model in a comparison sees byte-identical instances. This mirrors ESAC-GI deliberately: two
  suites with different reproducibility rules would be two different standards.
- **Grading is deterministic wherever the task allows it.** A first call must match in tool and
  in parameters; a goal state is compared resource by resource; a reference solution has to pass
  the item's own hidden tests before the item counts as solvable. Ambiguity handling is the one
  judge-graded category, using the pinned model with 2x2 replication.
- **Expectations name only the fields an item is about.** A check that copied a whole record
  would credit a model for every field it never touched, and a run that did nothing would score
  most of the item. The state diff is written per field for that reason.
- **The efficiency modifier is separate from capability**, per amendment 001 §1: it can only be
  earned by a task that succeeded, it is weighted toward actions over tokens, and it is authored
  per task rather than being a universal count of tool calls.
- **Every item that runs code ships a reference solution**, and the test suite runs it against
  the item's own hidden tests. An item whose tests nothing can pass measures nothing, and the way
  to know is to pass them with something.

## Pools and efficiency

The public pool is the disclosed seed and the held-out pool is a different evaluator-controlled
seed. Run one pool at a time: there is no combined mode. Generate the ignored held-out seed with
`npm run esac -- seed new`, check only its existence with `npm run esac -- seed show`, and run it
with `--split heldout`. Reports carry the pool and a seed fingerprint, never the held-out seed.
The public pool is the reproducible artifact; a held-out seed must never appear in Git, logs,
issues, or documentation.

The five-point efficiency modifier is scored for successful tasks only. Each item has an authored
action and token envelope. The local 1 to 6 score weights action efficiency 3.5 and token
efficiency 1.5, then normalises into the five points. Failed or incomplete tasks earn no
efficiency points. The reference route anchors the envelope, but the model is not required to
copy it exactly.

## What is deliberately not here yet

The guided `auto` mode. The public JSONL artifact exists at
`public/esac-ag-v1.0-public.jsonl`; it omits hidden tests, reference solutions, expected tool
arguments, and held-out material.

The governance files the other repositories carry are here: the branch and tag rulesets as code
in `.github/rulesets/`, the contribution policy, the pull request workflow that closes
unsolicited contributions with a notice, the security policy, and the issue templates. Two things
in that area are missing on purpose. The rulesets **cannot be applied while this repository is
private**, because GitHub only offers them for public repositories on the free plan, and
`CITATION.cff` is absent because a citation file invites a citation and this suite cannot produce
a score to cite.
