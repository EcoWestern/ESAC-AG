<!--
Posted by .github/workflows/close-pull-requests.yml when a pull request arrives from
outside the organisation. Edit this file to change the reply: the workflow reads it rather
than carrying its own copy of the text.

This is the only thing a contributor sees when their work is closed without review, so keep
it short, keep it kind, and keep the route forward in it. Two rules for editing: do not
promise review, because there is none, and do not imply the contribution was bad, because
that is not why it was closed.
-->

Thank you for taking the time to look at ESAC-AG. This pull request has been closed without
review, which is what `CONTRIBUTING.md` says happens to upstream pull requests here.

That is a decision about the instrument rather than about your work. A published benchmark score
has to be traceable to a specific, trusted revision, so item generators, graders, and scoring
rules cannot change through an external merge path. If they could, a score out of 75 would not
reliably mean the same thing twice.

Two routes are open, and both are welcome:

- **Open an issue** using the bug report, item challenge, or methodology question template. An
  item challenge is the most useful report this project can receive, and a patch is not the only
  way to convey what it found. For this suite that is especially true of the injection items:
  if a payload has an obvious fix that defeats it, or reads as a puzzle rather than as an
  instruction, that is worth knowing and does not need a pull request.
- **Fork the repository.** The MIT licence permits it, and a fork is the intended path for
  anyone who wants to change what the benchmark measures. If you publish results from a fork,
  give the fork its own name and version tag rather than labelling them ESAC-AG scores, and cite
  this repository as the origin.

If this pull request contains something the project should have, saying so in an issue is the
fastest route to it being considered. Issues are read.
