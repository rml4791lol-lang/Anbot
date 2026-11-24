---
name: anbot-code-review
description: Inspect a diff and verify concrete risks against the changed behavior.
---

Read repository instructions and the actual base-to-candidate diff. Follow changed values into their callers and storage boundaries. Check upgrade paths, failures, concurrency and permission changes where the diff makes them relevant.

For each finding, identify the exact triggering input or state, the affected behavior and a source location. Run a focused check when within scope. Report observed results separately from findings based on source inspection. Retain user edits during review and propose fixes only for demonstrated risks.
