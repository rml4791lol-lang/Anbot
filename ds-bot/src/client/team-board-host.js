// Mounts the team board as a panel of Anbot's own, not in DSH's right column: that
// column is a single seat the shell already holds (its session panel), and claiming it
// would either throw or unseat that panel — and a throw while mounting takes the whole
// shell group down with it. This panel lives in the overlay list instead, so it can
// never collide with a seat.
import { createElement as h, useEffect, useState } from 'react'
import { TeamBoard, readBoardConfig } from './team-board.js'

// Served by src/host/channel.js so the config can change without a rebuild.
export const TEAM_BOARD_CONFIG_URL = '/api/bot/team-board.config.json'

export const TEAM_BOARD_HOST_CSS = `
/* At 521px and up the panel keeps a 204px column of the page beside it (100vw - 204px);
   the sheet below owns 520px and under, so the two rules meet at a deliberate 1px boundary. */
.tbh{position:fixed;top:8px;right:8px;bottom:8px;width:min(380px,calc(100vw - 204px));display:flex;flex-direction:column;min-height:0;z-index:45;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);box-shadow:0 8px 32px rgba(0,0,0,.12),var(--bt-glass-shadow);overflow:hidden}
.tbh-toggle{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:45;writing-mode:vertical-rl;border:1px solid var(--bt-line);border-right:none;border-radius:10px 0 0 10px;background:var(--bt-card);color:var(--bt-ink);padding:12px 6px;font:inherit;font-size:12px;cursor:pointer}
/* Below 520px a floating card leaves the page beside it too narrow to read: the board
   takes the full width as a sheet across the top instead. */
@media (max-width:520px){
.tbh{top:0;left:0;right:0;bottom:auto;width:auto;max-height:46vh;border-width:0 0 1px;border-radius:0 0 12px 12px}
.tbh-toggle{top:0;right:8px;bottom:auto;transform:none;writing-mode:horizontal-tb;border-radius:0 0 10px 10px;padding:6px 10px}
}
`

// Slot injection flattens the injected `hooks` face into one `useXxx` prop per
// source, so the board reads them as ordinary snapshot hooks (like TeamSidebar).
export function TeamBoardHost({ useRoster, useWork }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value)
  const [open, setOpen] = useState(true)
  // The config may say the board starts closed; a dead config keeps the default.
  useEffect(() => {
    let live = true
    readBoardConfig(TEAM_BOARD_CONFIG_URL).then((config) => { if (live) setOpen(config.defaultOpen) })
    return () => { live = false }
  }, [])
  if (!open) {
    return h('button', { className: 'tbh-toggle', type: 'button', title: 'Team board', onClick: () => setOpen(true) }, '团队看板')
  }
  return h('aside', { className: 'tbh', 'aria-label': 'Team board' },
    h(TeamBoard, { roster, work, onClose: () => setOpen(false), configUrl: TEAM_BOARD_CONFIG_URL }))
}
