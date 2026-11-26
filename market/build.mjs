// Builds the catalog site from index.json and page.html.
// The page is a single file with the index inlined, so it opens by double-click
// and needs no server. Run: node market/build.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'))
const page = readFileSync(join(root, 'page.html'), 'utf8')

const siteUrl = index.indexUrl.replace(/index\.json$/, '')
const updatedDate = index.updated.slice(0, 10)
const kindLabel = Object.fromEntries(index.kinds.map(k => [k.id, k.label]))
const trustLabel = Object.fromEntries(index.trust.map(t => [t.id, t.label]))

const itemList = index.items.map((it, i) => ({
  '@type': 'ListItem',
  position: i + 1,
  item: {
    '@type': it.kind === 'mcp' || it.kind === 'plugin' ? 'SoftwareApplication' : 'CreativeWork',
    name: it.name,
    description: it.summary,
    identifier: it.id,
    ...(it.version && !['—', '内置'].includes(it.version) ? { version: it.version } : {}),
    ...(it.homepage ? { url: it.homepage } : {}),
    ...(it.kind === 'mcp' || it.kind === 'plugin'
      ? { applicationCategory: 'DeveloperApplication', operatingSystem: 'Windows, macOS, Linux' }
      : {}),
  },
}))

const jsonld = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Anbot 配置市场',
  alternateName: 'Anbot Market',
  url: siteUrl,
  description: `Anbot 的 DSH 原生配置市场：预设、技能、MCP、插件四类条目，共 ${index.items.length} 条，读同一份 index.json；在本机安装，不经服务器。`,
  inLanguage: 'zh-CN',
  dateModified: index.updated,
  isAccessibleForFree: true,
  publisher: { '@type': 'Organization', name: 'Anbot', url: 'https://github.com/rml4791lol-lang/Anbot' },
  mainEntity: { '@type': 'ItemList', numberOfItems: index.items.length, itemListElement: itemList },
}
const jsonldScript = `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>`

const html = page
  .replaceAll('__ANBOT_INDEX__', JSON.stringify(index).replace(/</g, '\\u003c'))
  .replaceAll('__INDEX_URL__', index.indexUrl)
  .replaceAll('__INSTALL_CMD__', index.install)
  .replaceAll('__SITE_URL__', siteUrl)
  .replaceAll('__COUNT__', String(index.items.length))
  .replaceAll('__UPDATED__', updatedDate)
  .replaceAll('__JSONLD__', jsonldScript)

const out = join(root, 'site')
mkdirSync(join(out, 'assets', 'anbot'), { recursive: true })

writeFileSync(join(out, 'index.html'), html)
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n')

const counts = index.kinds.map(k => `${k.label} ${index.items.filter(i => i.kind === k.id).length}`).join(' / ')
const llms = [
  '# Anbot 配置市场',
  '',
  `> ${index.about}`,
  '',
  '## 索引',
  `- 站点: ${siteUrl}`,
  `- 索引: ${index.indexUrl}`,
  `- 安装: ${index.install}`,
  `- 条目: ${index.items.length}（${counts}）`,
  `- 更新: ${updatedDate}`,
  '',
  '## 条目',
  '',
]
for (const k of index.kinds) {
  llms.push(`### ${k.label}`, '')
  for (const it of index.items.filter(i => i.kind === k.id)) {
    const v = it.version && !['—', '内置'].includes(it.version) ? ` ${it.version}` : ''
    llms.push(`- ${it.name}（${k.label}，${it.id}，${trustLabel[it.trust] || it.trust}${v}）：${it.summary}`)
  }
  llms.push('')
}
llms.push('## 说明', '', '预设和技能只改配置；MCP 和插件会在本机执行代码，装前核对来源与权限。', '', '## 相关', '', '- 仓库: https://github.com/rml4791lol-lang/Anbot', '- DSH: https://github.com/deepseek-ai/deepseek-harness', '')
writeFileSync(join(out, 'llms.txt'), llms.join('\n'))
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`)
writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}</loc><lastmod>${updatedDate}</lastmod><changefreq>weekly</changefreq></url>\n</urlset>\n`)
for (const f of ['mascot.webp', 'mascot-face.webp']) copyFileSync(join(root, 'assets', f), join(out, 'assets', f))

for (const f of readdirSync(join(root, 'assets', 'anbot'))) {
  if (!f.endsWith('-160.webp')) continue
  copyFileSync(join(root, 'assets', 'anbot', f), join(out, 'assets', 'anbot', f))
}

console.log(`built ${index.items.length} items → site/index.html`)
