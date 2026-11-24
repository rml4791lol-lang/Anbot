---
name: anbot-ui-review
description: Review or repair a user interface against the running product, including desktop and narrow layouts, interaction states, and accessibility evidence.
---

## Ground the interface

Use only tools present in this Session. If a named tool is unavailable, use an exposed equivalent and state which evidence it could not produce.

Read the repository instructions, the user-visible objective, the product's design standard and the commands that start or test the relevant app. Use `glob`, `grep` and `read` to find the actual entry point, styles, components and existing browser or screenshot tests before judging the page.

For multi-step work, keep a whole-list plan with `todo_write`. Treat the current working tree as the user's work. Read a file before using `edit`, keep unrelated changes, and create a new file with `write` only when the task requires it.

## Observe the product

Run the project through its existing command with `bash`, or `pwsh` when that is the visible Windows shell. Open the page with the project's browser or desktop harness. When the Session exposes the Bot browser, use `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press` and `browser_screenshot` to exercise the page. If the flow requires a login, payment or captcha, use `browser_handoff` and stop. When the current model accepts images and `read_image` is exposed, use it to inspect screenshots and other supplied visual references.

Check the real desktop layout and a narrow layout. Exercise the relevant default, loading, empty, error, disabled, long-content and keyboard-focus states. Look for clipped text, overlapping controls, hidden actions, misleading state, inaccessible contrast and focus that moves without a visible target. Use browser or app console output when the harness exposes it.

If the available harness cannot set a width or reach a required state, say that state is unverified. Do not infer a rendered result from source alone or describe a screenshot that was not captured.

## Repair and verify

Make the smallest UI change that resolves the observed problem and preserves the surrounding product behavior. Follow the existing component and styling patterns. Add or update a test when the repository expects one for the changed behavior, but keep unrelated tests and translations unchanged unless they belong to the requested fix.

Re-run the original flow at both reviewed widths and repeat the affected interaction with the keyboard. Run the nearest focused checks, then the repository checks required by its instructions. Report the commands, observed results and screenshot or browser evidence for each reviewed width. List any state that remained unreachable separately from findings based only on source inspection.
