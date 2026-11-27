---
name: gh-fix-ci
description: Use when the user asks to debug or fix failing GitHub pull request checks or GitHub Actions runs. Finds the failing checks with gh or a granted GitHub connection, reads their logs, locates the cause and, when the task asks for a fix, makes a focused fix. Checks from other CI providers are reported by URL only.
---

# Fix failing GitHub CI

## Overview

Locate the failing checks of a pull request or a GitHub Actions run, read the logs of the failures that GitHub
Actions produced, summarize each failure with its log snippet, find the cause, and fix it when the task asks for a
fix. Checks from other providers (for example Buildkite) are out of scope: report their details URL only.

Reference files in this skill are read with `read_skill_file` where that tool is offered, otherwise from this
skill's folder.

## Follow the user's task and the project's rules

- **The task sets the scope.** When the user asked you to fix the CI, go from diagnosis to a focused fix without
  stopping for a separate plan approval; your hand-over says what you planned and did. When the user asked only to
  look at or explain a failure, deliver the diagnosis and a fix plan and change nothing.
- **The project's rules apply.** Follow the repository's own contribution and agent instruction files and any team
  rules: their required checks, branches, commit conventions and reviews. This skill adds no gates of its own.
- **Outward actions.** Do anything that changes GitHub only when the task asks for it, and prepare the exact
  destination and content first. UnodeAi recognises `git push`, `gh pr create`, `gh pr comment`, `gh pr review` and
  `gh pr merge` as outward actions; they go through the normal confirmation of that exact action.
- **Writes UnodeAi does not recognise.** `gh run rerun` and `gh workflow run` start new CI runs on GitHub, which can
  use paid minutes; `gh pr edit` and `gh api` calls that change something also write to GitHub. UnodeAi does not
  recognise these as outward actions: they get no outward-action confirmation, only the normal command permission.
  Run them only when the user's task asks for exactly that. Do not start a CI run on your own to check a fix; check
  it locally and say that the remote result is unknown until CI runs again.

## Inputs

- `repo`: a path inside the repository (default `.`)
- `pr`: pull request number or URL (optional; defaults to the current branch's pull request), or a run URL or id
- Access to the repository's GitHub host: a granted GitHub integration or a signed-in `gh`

## When gh is missing or not signed in

Go through these in order.

1. **Use what is already there.** A granted GitHub integration whose tools can read checks and logs, or `gh` already
   on `PATH` and signed in. Check with `gh --version` and `gh auth status`; the second shows the host and account.
   Never add `--show-token`.
2. **gh is not installed.** If a granted integration can do the reading, use it. Otherwise installing `gh` is a
   system install and needs one ask first: name the exact command for this machine (for example
   `winget install --id GitHub.cli` on Windows, `brew install gh` on macOS, or the Linux distribution's package),
   where it installs, and its approximate size if you know it; say the size is unknown if you do not. If the user
   approves, run it. If they decline, or you have no way to ask, report the missing tool and the exact command, and
   continue with the work that does not need it.
3. **gh is not signed in.** Do not look for tokens in files or environment variables, and do not ask the user to
   paste a token into the chat. Name the host (github.com, or the enterprise host from the remote URL) and give the
   exact command for the user to run in their own terminal: `gh auth login --hostname <host>`. Reading logs usually
   needs the `repo` and `workflow` scopes. An installed `gh` is not a signed-in `gh`: say which of the two is true.
   Until the user signs in, continue with what needs no GitHub access: read the workflow files and reproduce the
   failing step locally.

## Workflow

1. **Resolve the pull request or run.**
   - Prefer the current branch's pull request: `gh pr view --json number,url`.
   - If the user gave a pull request number or URL, or a run URL or id, use that directly.
2. **Inspect the failing checks (GitHub Actions only).**
   - With Python available, the helper in `references/inspect-pr-checks-helper.md` does this in one read-only run and
     handles gh field drift and job-log fallbacks. Write it into the workspace and run it as that file describes.
   - Otherwise use `gh` directly:
     - `gh pr checks <pr> --json name,state,bucket,link,startedAt,completedAt,workflow`
       - If a field is rejected, rerun with the available fields `gh` reports.
     - For each failing check, take the run id from its link and run:
       - `gh run view <run_id> --json name,workflowName,conclusion,status,url,event,headBranch,headSha`
       - `gh run view <run_id> --log-failed` for the failed steps, or `gh run view <run_id> --log` for the whole log
     - If the run log says it is still in progress, fetch the job log directly:
       - `gh api "/repos/<owner>/<repo>/actions/jobs/<job_id>/logs" > "<path>"`
3. **Scope checks from other providers.** If a check's link is not a GitHub Actions run, label it as external and
   report only the URL.
4. **Summarize the failures.** For each: the check name, the run URL, and a concise log snippet. Say explicitly when
   a log is missing. A workflow can print secrets into its log: redact any before quoting.
5. **Find the cause.** Read the code and configuration the failing step touches. Where you can run commands,
   reproduce the failing step locally with the same command the workflow runs. Separate a failure in the change from
   one in the environment (a flaky test, a runner image, a missing secret) and say which you found.
6. **Fix, when the task asks for it.** Make the smallest change that removes the cause, following the project's
   rules. Run the failing step locally and the tests around the change.
7. **Report.** What failed, why, what you changed, and which local checks you ran with their results. Whether CI
   passes is known only after it runs again: after a push the task asked for, `gh pr checks <pr>` (read-only) shows
   the new state. Do not report remote CI as passing from local results.

## Reference files

- `references/inspect-pr-checks-helper.md`: the upstream check-inspection script as reference text, with how to write
  it into the workspace and run it.

---
Adapted from the Apache-2.0 `gh-fix-ci` skill in github.com/openai/skills. What changed and why is listed in
`SOURCE.md`; the license is in `LICENSE.txt`.
