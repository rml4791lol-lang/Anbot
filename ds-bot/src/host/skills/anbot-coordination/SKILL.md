---
name: anbot-coordination
description: Plan and hand off work to live team Bots through the available local team tools, then verify and integrate the evidence they return.
---

## Establish the live team

Use only tools present in this Session. If a named team tool is unavailable, use an exposed equivalent and report which handoff or check could not run.

Begin with `read_inbox`. Use `list_bots` to get the current Bot names, roles, working context and activity. Do not rely on remembered team membership or assume that a child Agent, subagent, workflow, teammate or background dispatcher exists. This Bot Session coordinates only the team entries that `list_bots` can currently observe.

Use `todo_write` for your own bounded plan. In a group, use `group_todo` for the shared checklist and `group_goal` when the group already has an outcome and stages that need status. Only the group admin or a Main Bot changes a group goal. Read `read_own_chat` or `read_group_chat` before relying on older context.

## Hand off work

For one Bot, use `message_bot` with an exact recipient name and a self-contained handoff. State the outcome, the facts and file paths the Bot needs, the work it owns, constraints on user changes, the acceptance check and the result format. Pass `when: "queue"` only for a new task unrelated to what that Bot is already doing. When a handoff may need retry, give it a stable `request_id` and reuse that id only when the entire handoff, including recipient, message, reply target and timing, is identical. A successful tool result is the evidence that the handoff exists.

For a group, name the members with `@Name` in that group's turn or use `post_to_group` from outside it. Use `message_bot` carefully inside a group because it reaches only members of that group. Pass `report_back: true` to `post_to_group` only when the reply must return to the current work.

Send each request one way. Do not send acknowledgements, repeat the same handoff under a new `request_id`, or invent task or worker identifiers that no visible tool provides. Replies arrive automatically as new turns. Do not poll, block a turn waiting for another Bot, or call a hidden dispatcher.

## Verify and report

When work returns, inspect the changed files or other evidence yourself with `read` and `grep`. Run the stated acceptance check with `bash` or `pwsh` when it is available, compare the result with the original request and preserve unrelated user edits. Send a follow-up only for a concrete gap or a changed constraint.

Report which Bot did what, the observed command and result, and any handoff or state that remained unverified. Use `update_team_board` for a durable decision or blocked status when the team needs to see it. Ask the user with `ask_user` when a choice belongs to them.
