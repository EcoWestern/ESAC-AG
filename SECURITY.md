# Security

## Reporting

Report privately, through
[the security advisory form](https://github.com/EcoWestern/ESAC-AG/security/advisories/new).
Do not open a public issue for any of the following.

## What matters most here

This repository executes code that a model wrote. That makes it the only suite in the program
with a part that could damage the machine it runs on, so the honest position is that the sandbox
is the highest-value thing to attack and the highest-value thing to report.

A report is useful if it is any of:

- **A way out of the sandbox.** Reading or writing outside the throwaway directory, starting a
  process or a worker thread, loading a native addon, or reaching anything in the parent's
  environment. The sandbox is meant to fail closed: `esac sandbox` reports whether the platform
  is enforcing the refusals, and nothing runs if it cannot prove that it is. A case where the
  proof passes but the refusal does not hold is the most serious thing that could be found here.
- **A hang or a resource escape.** A generated program that survives the wall-clock limit, the
  heap cap, or the output cap, or that leaves the machine in a worse state than it found it.
- **A held-out seed leak.** A held-out dataset seed in a commit, a log, a report, or an issue.
  The pool's usefulness ends the moment the seed is public.
- **Judge manipulation.** The judge-graded category is not implemented yet. When it is, examples
  of a response that reliably bends the rubric are in scope.

## What is a known limitation rather than a vulnerability

Stated here so that a report does not have to establish it first: **Node cannot restrict network
access per process**, and there is no per-process permission to set. A program running in the
sandbox could open a socket. The defence is that the sandbox environment is built from nothing,
so it carries no key, no token, and no proxy setting, and the tasks are offline by construction.
A report that turns this into exfiltration of something real is still in scope; a report that
restates the limitation is not.

The other known limits: the caps are enforced by Node and by the parent process rather than by
the operating system, so they are not a container; and a program may consume CPU for up to the
wall-clock limit, which is why the limit is five seconds.

## Supported versions

Only the current implementation version on the default branch. This suite cannot produce a score
yet and has no released version, so nothing is maintained in parallel. That will change when a
benchmark version exists, and the rules in the ESAC specification will apply.
