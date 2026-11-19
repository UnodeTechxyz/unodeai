---
name: webapp-testing
description: Use when a task needs a local web page or web app checked in a real browser - verifying frontend behaviour, debugging UI, taking screenshots or reading browser console logs. Prefers the granted Playwright integration and falls back to a Playwright script written into the workspace.
---

# Web Application Testing

Test a local web application by driving a real browser: open the page, interact with it, take screenshots and read
its console. This skill covers web pages and web apps. It does not drive the editor's own interface.

Reference files in this skill are read with `read_skill_file` where that tool is offered, otherwise from this
skill's folder.

## Choose the tool, in this order

1. **The Playwright integration, when it is granted to you.** This is the managed Playwright MCP integration from
   the UnodeAi integration catalog (id `playwright`). Its tools appear in your tool list; use them under the names
   listed there to navigate, read the page (an accessibility snapshot), click, type, take screenshots and read
   console messages. It needs no helper code. If this agent does not have it and the task needs a browser, tell the
   user once that it can be granted to the agent under **MCP grants** in the Agent Builder, and continue with the
   next option.
2. **The project's own browser tests.** If the project already has Playwright (for example `@playwright/test` or
   `playwright` in `package.json`, a `playwright.config.*` file, or the `playwright` package in the project's Python
   virtual environment), use its configuration and its own test scripts.
3. **A script written into the workspace**, when neither of the above can do the step: for example several servers
   started together around one scripted check. Write the helper from `references/with-server-helper.md` and a check
   script based on `references/examples.md` into the workspace (for example under `.skill-helpers/`) and run them
   with your normal command permission. Tell the user what you wrote and where, and remove it when the task is done
   unless they want to keep it.

## Missing tools

Go through these in order.

1. **Use what is already there.** The granted integration, or the project's own `node_modules`, virtual environment
   or declared packages. This starts no new download.
2. **Install inside the project when the task needs it.** Asking for the work ("test it") includes installing what
   the work needs inside the project: for example a project virtual environment (`python -m venv .venv`, then
   `.venv\Scripts\python -m pip install playwright==<version>` on Windows or `.venv/bin/python -m pip install
   playwright==<version>` elsewhere) or a dev dependency (`npm install --save-dev @playwright/test@<version>`). Pin
   an exact version, keep it in the project, and tell the user what you added.
3. **Ask once before a machine-wide install or a large download.** The Playwright browser download
   (`playwright install chromium`, or the same through `npx playwright install chromium`) is usually hundreds of MB
   and goes to a per-user cache outside the project (`%USERPROFILE%\AppData\Local\ms-playwright` on Windows,
   `~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS). The same holds for a global `npm`
   or `pip` install. Before it, ask once and name the exact command, where it installs and the approximate size (say
   it is unknown if you cannot tell). If the user approves, run it. If they decline, or you have no way to ask,
   report what is missing and the exact command, and continue with what needs no browser: read the HTML and source
   for selectors, run the project's other tests, and report the browser checks as not run.

If the Playwright integration itself reports that its browser is missing, that download is the same step 3.

## Decision tree

```
User task → Is it static HTML?
    ├─ Yes → Read the HTML file directly to identify selectors
    │         ├─ Success → Open it (file URL) with the integration or a script, and act on those selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Start it the project's way. If your command tool cannot keep a server running while you
        │        use the browser, run the server and a scripted check together with the server helper.
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait until the page is ready
            2. Take a snapshot or screenshot, or inspect the DOM
            3. Identify selectors from the rendered state
            4. Execute actions with the discovered selectors
```

## Reconnaissance-then-action

1. **Inspect the rendered page**: with the integration, take a page snapshot or screenshot; in a script:
   ```python
   page.screenshot(path='.skill-helpers/output/inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   ```
2. **Identify selectors** from what you saw.
3. **Execute actions** using the discovered selectors.

## Waiting

Wait for a condition, not for a fixed time: the element, text or URL the next step needs
(`page.wait_for_selector()`, `page.wait_for_url()`), or `page.wait_for_load_state('networkidle')` for a dynamic app
that has no clearer ready signal. Do not inspect the DOM of a dynamic app before it is ready. Use a fixed pause only
to observe something time-based, and say so.

## Best practices

- Use `sync_playwright()` for synchronous scripts, and launch Chromium headless unless the task needs to see it.
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs.
- Write screenshots and logs into the project (for example `.skill-helpers/output/`, or the folder the project uses
  for test output), never to a fixed system path.
- Clean up: close the browser (the integration's close tool, or `browser.close()`), and stop every server you
  started. The server helper stops the whole process tree; for a server you started another way, stop it and check
  that its port is free.

## Report what you observed

Report each step you ran and what you saw: the screenshots (with their paths), the console errors and warnings, and
the step that failed with its error. Call a check visual only when you looked at a screenshot or a snapshot. If a
step could not run (no browser, no server), say which and why; do not report it as passed.

## Reference files

- `references/with-server-helper.md`: start one or more servers, run a command, stop them all (adapted from the
  upstream `scripts/with_server.py`).
- `references/examples.md`: example scripts for element discovery, a local static HTML file, and console log
  capture (adapted from the upstream `examples/*.py`).

---
Adapted from the Apache-2.0 `webapp-testing` skill in github.com/anthropics/skills. What changed and why is listed in
`SOURCE.md`; the license is in `LICENSE.txt`.
