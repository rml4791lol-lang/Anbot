# Anbot 配置目录

一个静态目录站：预设、技能、MCP、插件四类条目，读同一份 `index.json`。

- `index.json` — 索引契约与条目（唯一数据源）
- `page.html` — 页面模板：奶油纸底 + 墨线描边 + 硬投影的贴纸版式（看板娘与贴纸、波浪花边、彩色步骤卡、描边卡片与分类药丸、详情抽屉）；版式与视觉语言按社区市场的设计系统重画（奶油纸、墨线、硬投影、波浪花边），插画、图标、代码全部自己画自己写，不复制第三方前端代码与素材
- `build.mjs` — 把索引注进页面，输出自包含的 `site/index.html`
- `assets/` — 15 个角色头像、`mascot.webp`（Anbot 主 Bot 的纸艺看板娘，由项目角色形象扩展）与 `mascot-face.webp`（页首头像）

构建：

```sh
node market/build.mjs
```

发布：把 `market/site/` 整个目录传到任意静态托管即可；`index.html` 双击也能直接打开。

约定：

- 条目字段以 `index.json` 里的 `kinds`、`trust` 为准；`install` 是一行能跑的命令。
- `preset` / `skill` 只改配置，`mcp` / `plugin` 会在本机执行代码，页面按 `risk` 标「会跑代码」。
- 插件不复制索引，`sources.plugin` 指向 DSH 开放市场，只显示入口与信任状态。

下一步是 Anbot 内置「发现」页读同一份 `index.json`，安装、卸载走本地 store；站点只是它的另一个前端。
