const attention = site => site.health?.status === 'offline' || site.health?.status === 'error'
const visible = site => site?.archived !== true

function matches(site, query) {
  if (query === '') return true
  return [site.name, site.url, site.notes, ...(site.tags ?? [])]
    .some(value => String(value ?? '').toLowerCase().includes(query))
}

function orderSites(sites) {
  return [...sites].sort((left, right) =>
    Number(right.favorite) - Number(left.favorite)
    || Number(attention(right)) - Number(attention(left))
    || left.order - right.order
    || left.name.localeCompare(right.name))
}

export function siteCatalogModel(directory, { environment = 'all', query = '', includeArchived = false } = {}) {
  const needle = String(query ?? '').trim().toLowerCase()
  const groupsInOrder = [...(directory?.groups ?? [])].sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
  const rows = (directory?.sites ?? []).filter(site => includeArchived || visible(site))
    .filter(site => environment === 'all' || site.environment === environment)
    .filter(site => matches(site, needle))
  const byGroup = new Map(groupsInOrder.map(group => [group.id, []]))
  const ungrouped = []
  for (const site of rows) {
    if (site.groupId !== null && byGroup.has(site.groupId)) byGroup.get(site.groupId).push(site)
    else ungrouped.push(site)
  }
  const groups = [
    ...groupsInOrder.flatMap(group => {
      const sites = orderSites(byGroup.get(group.id) ?? [])
      return sites.length === 0 ? [] : [{ ...group, sites }]
    }),
    ...(ungrouped.length === 0 ? [] : [{ id: '__ungrouped__', name: 'Ungrouped', color: null, order: Number.MAX_SAFE_INTEGER, sites: orderSites(ungrouped) }]),
  ]
  return {
    groups,
    sites: orderSites(rows),
    total: rows.length,
    counts: directory?.counts ?? {},
  }
}
