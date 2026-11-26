# 源码分发与发布前置清单

本清单记录「干净 clone 一条命令装好」的实际验证结果、签名与 Gatekeeper 结论、品牌身份残留、密钥扫描结论，以及手机端打包的前置条件。验证基线：clone 自 `2a10f635`（分支 `chore/anbot-merge-upstream`），macOS arm64，Node v22.23.2，npm 10.9.8（npm 11.21.3 经 npx 调用）。

## 1. 源码构建路径

### 1.1 前置要求

- Node.js **22.19 或更高**（CI 同时验证 22 与 24；推荐 24），**npm 11 或更高**，Git。
- 应用 lockfile 由 npm 11 生成；npm 10 执行 `npm ci` 会报 lockfile 不同步（`Missing: ws@8.23.0 from lock file`）。升级方式：换 Node 24（自带 npm 11），或 `npm install -g npm@11`。
- macOS：Xcode Command Line Tools（`xcode-select --install`）。
- Linux：`build-essential` 与 `python3`（Debian/Ubuntu：`sudo apt-get install build-essential python3`）。
- Windows：Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载，以及 Python 3。
- 代理/镜像：安装前设置 `npm_config_proxy` / `npm_config_https_proxy`；Electron 下载设置 `ELECTRON_MIRROR`，electron-builder 自身工具下载设置 `ELECTRON_BUILDER_BINARIES_MIRROR`。

### 1.2 一条命令

```sh
git clone <repo> Anbot
cd Anbot
sh scripts/setup.sh          # Windows: pwsh scripts/setup.ps1
(cd app && npm run build && npm run pack)
```

`scripts/setup.sh`（POSIX sh，macOS/Linux）依次：检查 Node/npm/Git → ds-bot `npm ci` → link `npm ci` → `ds-bot npm run build`（生成 `client.js`、`link.js`）→ 安装 DSH 测试 harness（`--without-harness` 跳过）→ app `npm ci`（`--plugin-only` 跳过）→ `build-client.mjs --check`。任一步失败非零退出并给出可读原因；重复执行安全。`scripts/setup.ps1`（PowerShell 7）语义对齐；**本机未装 pwsh，ps1 仅做了语法层面的编写，未在本机运行，由 CI 的 windows-latest 任务验证**。

### 1.3 干净 clone 实测记录

| 步骤 | 结果 | 耗时 |
| --- | --- | --- |
| `git clone`（本地路径） | HEAD `2a10f635`，工作区干净 | 0.37 s |
| `sh scripts/setup.sh`（旧版，仅 ds-bot/link/harness） | 退出 0 | 25.1 s |
| `ds-bot npm run build` | 退出 0 | 0.28 s |
| `node scripts/build-client.mjs --check` | 退出 0 | — |
| `ds-bot npm test` | 5288 项：5257 通过，3 失败，24 取消，4 跳过；退出 1 | 48.8 s |
| `app npm ci`（npm 10.9.8） | **失败**：EUSAGE，lockfile 不同步，`Missing: ws@8.23.0` | 0.6 s |
| `app npm ci`（npm 11.21.3） | 退出 0，1164 包 | 12.6 s |
| `app npm run build`（vite） | 退出 0 | 0.78 s |
| `app npm test` | 707 项：704 通过，0 失败，3 跳过；退出 0（README 发布链接补齐后） | 3.6 s |

ds-bot 既有失败（干净 clone 基线，与本次改动无关）：

- `test/local-agents-startup.test.js:125`：`Command must be a program name, an absolute path, or a ~/path`；其父用例 `#1390 taken routes cannot be selected or probed as local agents` 记为 subtestsFailed。
- `test/malformed-response.test.js:114`：Gemini `MALFORMED_RESPONSE` 错误文案断言不一致（实际 `Provider stopped with: MALFORMED_RESPONSE`，期望 `Unhandled stop reason: MALFORMED_RESPONSE`）。
- 另有 24 个 `cancelledByParent` 用例随父用例取消。

### 1.4 什么时候必须重新构建客户端 bundle

`ds-bot/client.js`、`ds-bot/link.js` 已提交。Git clone 或 `npm pack` 安装直接使用它们；只有改动 `ds-bot/src/client/` 或 `link/src/` 后才需要：

```sh
(cd ds-bot && npm run build)
node scripts/build-client.mjs --check
```

单元测试在 `client.js` 过期时也会失败。不跑构建步骤，也可以用已提交的 bundle 跑插件测试，或把插件打成 tgz 装进 DSH。

## 2. 签名、quarantine 与 Gatekeeper

- **源码分发不需要任何证书。** 从源码 `npm run pack` / `dist` 出的包是本地编译产物，不经过浏览器下载通道，**不带 `com.apple.quarantine` 属性**，macOS Gatekeeper 不会按「未识别开发者」拦截。
- 实测本机已装包 `/Applications/Anbot.app`：`xattr` 仅含 `com.apple.provenance`，无 `com.apple.quarantine`；签名为 **adhoc**（`Signature=adhoc`，`TeamIdentifier=not set`），`spctl -a` 评估为 rejected——该评估只对带 quarantine 的下载副本生效，本地编译运行不触发。
- 预编译安装包（发给其他用户的 zip/exe/AppImage）属于另一个议题：macOS 包沿用上游做法出 zip，ad-hoc 签名（`identity: '-'`），不公证、不用 Developer ID，首次打开由用户在「隐私与安全性」手动放行；Windows exe 在 CI 上用注入的项目自签 PFX 做 Authenticode 签名（非商业 CA 证书）。签名方案、证书与发布流程见 [release-signing.md](release-signing.md)，本源码构建流程不做签名。

## 3. 品牌与身份残留清单

### 3.1 本次已改（文档/元数据，未改代码身份标识）

| 文件 | 改动 |
| --- | --- |
| `NOTICE:1-5` | 产品名改为 Anbot；保留 DS Bot 上游版权归属（Fei2411 及贡献者，Apache-2.0）；正文自指 DS Bot 改为 Anbot（130-131、153、254、286、294 行） |
| `README.md:222,233` | 致谢段保留 DS Bot 上游链接与作者归属；自指改为 Anbot；新增 Quickstart、前置依赖、代理、bundle 重建时机、签名/Gatekeeper 说明；补 `releases/latest` 链接 |
| `README.zh.md:222,233` | 与英文同步 |
| `docker/Dockerfile:54` | 镜像 LABEL title 改为 Anbot |
| `docker/Dockerfile.dev:66-67` | 开发镜像 LABEL title/description 改为 Anbot |
| `docker/README.md:1,3,38,51,190,251` | 产品自指改为 Anbot；保留 `ds-bot` 服务名/路径/标签等内部标识 |
| `docker/README.dev.md:1` | 标题改为 Anbot |

### 3.2 待发布前决策（本次未改，均有兼容性或构建验证影响）

**手机端身份（`mobile/`）**——改 bundle id / scheme 等于换一个新应用，已安装用户无法覆盖升级；当前没有公开 iOS 版本，Android 已随 v0.0.1 公开分发，改包名 / scheme 后旧包不能覆盖升级，需要完整原生构建与双端回归：

| 文件:行 | 现状 | 说明 |
| --- | --- | --- |
| `mobile/app.json:4` | `slug: "dsbot"` | Expo 项目 slug |
| `mobile/app.json:8,9` | web `name`/`shortName` = "DS Bot" | 浏览器端显示名 |
| `mobile/app.json:19` | iOS `bundleIdentifier: io.github.fei2411.dsbot` | 改后需在 Apple Developer 注册新 App ID |
| `mobile/app.json:33` | Android `package: io.github.fei2411.dsbot` | 改后新包名，旧包不能覆盖升级 |
| `mobile/app.json:38` | `scheme: "dsbot"`；`mobile/App.tsx:126` 匹配 `dsbot://pair` | 改 scheme 会使已配对的深链失效 |
| `mobile/app.json:44` | 相机权限文案 "DS Bot …" | 展示文案 |
| `mobile/app.json:57` | ProGuard keep `io.github.fei2411.dsbot.system.**` | 随系统包名一起改 |
| `mobile/package.json:2` | `name: dsbot-mobile`（lockfile 同步） | npm 包名 |
| `mobile/plugins/android-native.js:9,87,95,164,165` | 系统包名、FileProvider authorities、更新路径 XML、通知图标资源名 | 原生插件标识 |
| `mobile/plugins/android-native/*.kt` | 包名 `io.github.fei2411.dsbot.system`、动作 action、通知默认标题 "DS Bot" | Kotlin 包与字符串 |
| `mobile/app.config.js:1,16` | 注释旧名；环境变量 `DS_BOT_APPLE_TEAM_ID` | 环境变量改名需兼容旧名 |
| `mobile/README.md:1,3,5` | 文档自指已改为 Anbot | 文档；原生身份标识（见上）待发布前决策 |

**Docker 内部标识**（不影响对外品牌，可延后）：

| 文件:行 | 现状 |
| --- | --- |
| `docker-compose.yml:6,7` | 服务名 `ds-bot`，本地标签 `ds-bot:local` |
| `docker-compose.dev.yml:9,10` | 服务名 `ds-bot`，本地标签 `ds-bot:dev` |
| `docker/test.mjs:6`、`docker/test-dev.mjs:10,11` | 默认镜像标签 `ds-bot:local` / `ds-bot:dev` |
| `docker/README.md:35,179,185,186,209,247` | 服务名、容器内路径、本地标签引用 |

**环境变量兼容名**：`DS_BOT_*` 旧名仍被读取以兼容既有安装（如 `DS_BOT_UPDATE_URL` 是 `ANBOT_UPDATE_URL` 的别名，见 `app/src/updates.mjs:14`）。改名要保留旧别名，不能直接删。

**更新源**：`app/src/updates.mjs:7` 发布仓库已是 `rml4791lol-lang/Anbot`，Release 页 `…/releases/latest`；该文件属另一改动范围，本次未碰。

## 4. 密钥扫描结论

扫描范围：HEAD 工作区（`git archive HEAD` 全量 tracked 文件，走仓库自带 `scripts/scan.mjs`）+ 全部 70 个远端分支 tip + HEAD 历史中新增/删除的敏感文件名。

- **未发现高置信度真实密钥**：`sk-*`、`ghp_/gho_/ghu_/ghs_/ghr_`、`github_pat_*`、`AKIA*`、`AIza*`、Slack `xox*`、`BEGIN … PRIVATE KEY` 在所有分支 tip 的非测试代码中 0 命中；测试目录内只有 `xoxp-TEST-OK`、`xoxb-1` 这类明显占位值。
- 无 tracked 的 `.env` / `.pem` / `.key` / `.p12` / `.keystore` / `.jks` / `.mobileprovision` / `.p8` / `.cer`；唯一模板是 `docker/.env.example`，密钥字段留空。
- 历史文件：commit `7bcd047e`（仅存在于 `origin/feat/phase1a-e2e`，**不是 HEAD 祖先**）曾带入一个 `usage.sqlite` 测试数据文件；若该分支将来推到公开仓库，需要先清理历史。
- `scan.mjs` 标为 must-fix 的现存命中：
  - `docs/superpowers/plans/2026-11-24-ds-bot-harness.md:181`：计划文档里记录了本机绝对路径与 `/Users/an/.ds-bot/archive/…` 备份路径——公开仓库前应脱敏。
  - `ds-bot/dev/anbot-render-mark.py:45`：开发脚本硬编码 `/Users/an/Doubao/chats/…/anbot-identity/…` 素材路径——应改为环境变量或命令行参数；该脚本不进 npm 包，但在 Git 历史里。
  - `ds-bot/src/client/characters.js:87,107-111`：`LEGACY_REMAP` 里的旧厂商槽 id（kimi/qwen/glm/claude/gemini 等）是迁移兼容映射，不是位图表素材，扫描器按 look 文件规则报出；属有意保留。
- can-stay 类：测试/文档邮箱占位、版本号形式的数字串、供应商名称词、遗留迁移名等，扫描器已归类为可接受。

## 5. 手机端打包前置条件

### 5.1 Android（release.yml `app-android` 作业）

签名 release APK 使用三个 GitHub Secrets（在仓库 Settings → Secrets 配置，v0.0.1 已配置）：

| Secret | 用途 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 上传密钥 `.jks` 的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 `upload` |

前置：上传密钥库由维护者生成并保管，不进仓库；CI 用 JDK 17、Android SDK build-tools（zipalign/apksigner/aapt2）。本地开发另需 Android SDK 与模拟器/真机（Expo Go 不支持，用到原生模块）。

### 5.2 iOS（无 CI 签名作业，本机脚本归档）

**v0.0.1 不发布 iOS 包**：当前无 Apple Developer 账号，不构建也不上传 `.ipa` / TestFlight；以下均为账号材料齐备后的前置条件与未来流程，不代表 iOS 已支持或即将放出下载项。发布/TestFlight 上传走 `mobile/scripts/ios-archive.sh`，前置 Apple 账号与材料（详见 `docs/plans/2026-11-13-ios-release.md`）：

1. Apple Developer Program 会员（年费 99 美元，Account Holder 本人操作），并在 App Store Connect 接受协议。
2. Team ID（10 位）。
3. 与 bundle id 一致的 App Store Connect App 记录（当前 bundle id `io.github.fei2411.dsbot`，见 3.2）。
4. App Store Connect API Key：`.p8` 私钥 + Key ID（10 位）+ Issuer ID（UUID）。
5. 可选：TestFlight 内部测试 Apple ID 邮箱。

脚本读取的环境变量：`DS_BOT_APPLE_TEAM_ID`、`APPLE_API_KEY`（p8 路径）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、可选 `DS_BOT_IOS_BUILD_NUMBER`。`.p8` 与 Issuer ID 不进仓库、不贴聊天/Issue。CI 现有 iOS 任务只做无签名模拟器编译；签名归档与上传待账号材料齐备后走本机脚本或带 secret 的发布流程。

## 6. 未验证项

- `scripts/setup.ps1` 未在 Windows 真机/PowerShell 7 运行；本机无 pwsh。语法与语义由对照 `setup.sh` 编写，待 windows-latest runner 验证。
- 新 CI 工作流 `.github/workflows/setup.yml` 未在真实 runner 触发过；YAML 语法已本地解析通过。
- Linux 包构建（AppImage/deb）与 Windows 安装包未在本次干净 clone 上打包；本次只到依赖安装、bundle 生成与 web UI 构建。
- 手机端未执行原生构建；Android 密钥与 Apple 账号材料是否已在仓库/账号侧齐备，本地无法核验。
- ds-bot 三个失败用例的根因未在本阶段定位修复。
