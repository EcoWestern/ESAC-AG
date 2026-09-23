# ESAC-AG

**Agentic Work and Capability. Specified in full, partially implemented.**

> **Status: not a benchmark yet.** Six of the seven categories have items and a harness. No
> complete ESAC-AG score can exist, and nothing produced by this repository may be cited as one.
> A full run reports `INCOMPLETE`, which is the correct answer while one category is empty.
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
| Ambiguity handling | 5 | not implemented |
| Injection and safety resistance | 10 | **implemented**: 5 items, an instruction in the data and a dangerous tool it wants |
| Efficiency modifier | 5 | measured in every transcript, not yet scored |

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
  the item's own hidden tests before the item counts as solvable. The one judge-graded category,
  ambiguity handling, is not implemented yet.
- **Expectations name only the fields an item is about.** A check that copied a whole record
  would credit a model for every field it never touched, and a run that did nothing would score
  most of the item. The state diff is written per field for that reason.
- **The efficiency modifier is separate from capability**, per amendment 001 §1: it can only be
  earned by a task that succeeded, it is weighted toward actions over tokens, and it is authored
  per task rather than being a universal count of tool calls.
- **Every item that runs code ships a reference solution**, and the test suite runs it against
  the item's own hidden tests. An item whose tests nothing can pass measures nothing, and the way
  to know is to pass them with something.

## What is deliberately not here yet

Ambiguity handling and the pinned judge it needs, the efficiency modifier's normalisation,
the guided `auto` mode, the public and held-out pools, and the governance files the other
repositories carry. The changelog lists them so that they stay visible rather than becoming
folklore.
