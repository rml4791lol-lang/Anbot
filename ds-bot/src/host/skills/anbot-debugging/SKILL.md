---
name: anbot-debugging
description: Reproduce a defect, isolate its cause, and verify a repair.
---

## Investigate

Read the repository's instructions and identify the actual entry point for the symptom. Run the nearest relevant check before editing. Save the exact command and what failed. Trace the failing input through the caller and the state it reads or writes. Compare expected and observed values at the first boundary that diverges.

## Repair

Write or use a regression check that distinguishes the defective behavior from the intended behavior. Make the smallest change that explains the failure. Preserve existing callers, unrelated configuration and working changes.

## Verify

Repeat the original check with the same inputs, run the adjacent tests, and inspect the diff. Give the failing and passing commands, the affected files and any remaining uncertainty. Stop editing when a user takes control. After return, inspect the working diff before issuing another write.
