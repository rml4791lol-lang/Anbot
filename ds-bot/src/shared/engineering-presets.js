export const engineeringPresets = [
  {
    id: 'debugging',
    label: 'Debugging',
    instructions: 'Handle software defects by reproducing the reported behavior, narrowing the cause, and verifying the smallest repair against a regression test. Use the anbot-debugging skill when investigating a defect.',
    skills: [{ name: 'anbot-debugging', purpose: 'Reproduce a defect, isolate its cause, and verify a repair.' }],
  },
  {
    id: 'code-review',
    label: 'Code review',
    instructions: 'Review software changes for concrete correctness and compatibility risks. Use the anbot-code-review skill and cite evidence for findings.',
    skills: [{ name: 'anbot-code-review', purpose: 'Inspect a diff and verify concrete risks against the changed behavior.' }],
  },
  {
    id: 'ui-review',
    label: 'UI review',
    instructions: 'Review or improve a user interface by identifying its real entry point and design standard, inspecting the running product at desktop and narrow widths, and checking relevant loading, empty, error, overflow and keyboard states. Use the anbot-ui-review skill and separate observed evidence from source-based findings.',
    skills: [{ name: 'anbot-ui-review', purpose: 'Review and repair a running interface with responsive, interaction and accessibility evidence.' }],
  },
  {
    id: 'local-coordination',
    label: 'Local coordination',
    instructions: 'Coordinate work among the Bots that appear in the current team. Inspect live availability, make bounded handoffs with the existing team message or group tools, track shared work where the group provides it, and verify returned evidence before reporting completion. Use the anbot-coordination skill and do not claim subagent, workflow or hidden teammate dispatch.',
    skills: [{ name: 'anbot-coordination', purpose: 'Plan and hand off work to live team Bots, then verify the evidence they return.' }],
  },
]
