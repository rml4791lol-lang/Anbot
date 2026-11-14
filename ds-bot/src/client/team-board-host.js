// Mounts the team board in DSH's right column. The board itself owns its drawing;
// this host only hands it the roster and work snapshots the shell already keeps
// (both arrive over the live feed, so the board moves without a timer of its own).
import { createElement as h, useSyncExternalStore } from 'react'
import { TeamBoard, readBoardConfig } from './team-board.js'

// Served by src/host/channel.js so the config can change without a rebuild.
export const TEAM_BOARD_CONFIG_URL = '/api/bot/team-board.config.json'

const useSnapshot = source => useSyncExternalStore(source.subscribe, () => source.getSnapshot())

export function TeamBoardHost({ actions, hooks }) {
  const roster = useSnapshot(hooks.roster)
  const work = useSnapshot(hooks.work)
  return h(TeamBoard, { roster, work, onClose: actions.closeTeamBoard, configUrl: TEAM_BOARD_CONFIG_URL })
}

// The column starts open unless the config says otherwise; a dead config falls back
// to the board's own defaults.
export async function openTeamBoard(layout) {
  const config = await readBoardConfig(TEAM_BOARD_CONFIG_URL)
  if (config.defaultOpen) layout.openRightbar(true, false)
}
