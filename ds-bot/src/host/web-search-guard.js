import { repairWebSearchSelection } from '../../web-search.js'

// Issue #128: disabling the web-search-auto row leaves the web row's
// `searchProvider: auto` pointing at nothing, so every session's web_search
// fails with WEB_PROVIDER_CONFIGURED_MISSING. web-search.js repairs that from
// its own unmount; this module covers the boot where the row never mounted:
// it parks the notice provider once the web seam is there, and again whenever
// that service (re)appears under this Bot runtime.
export function install(rt) {
  const { ctx } = rt
  const repair = () => {
    const web = ctx.get('web')
    if (web !== undefined) repairWebSearchSelection(web)
  }
  repair()
  // The web service can appear or restart after install (row toggles, HMR);
  // a scope gated on the service re-runs the repair each time it is back.
  // The unit-test fake context has no `inject`, so guard for it.
  if (typeof ctx.inject === 'function') ctx.inject(['web'], () => repair())
}
