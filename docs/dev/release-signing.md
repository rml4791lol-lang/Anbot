# 签名与信任状态

本文记录 Anbot 各平台安装包的签名方式、系统信任状态、用户首次安装时会看到的提示与放行步骤，以及 Android 上传密钥的生成、入库和本地出包流程。与[发版前真机检查](release-checklist.md)配套：检查单管真机验收，本文管签名和信任的事实。

所有结论以仓库代码为准；标注「无账号」的地方（iOS）是现状，不是计划中的受信状态。

## 1. 各平台签名状态

| 平台 | 签名方式 | 证书 / 密钥来源 | CI secret | secret 状态 | 对外信任状态 | 更新方式 |
|---|---|---|---|---|---|---|
| Windows（NSIS `.exe`，x64） | electron-builder 在打包时做 Authenticode 签名，SHA-256 摘要，加盖 RFC 3161 时间戳（`http://timestamp.digicert.com`） | 项目自签证书（CN=Anbot Release Signing），不是商业 CA 颁发的代码签名证书；PFX（含私钥）经 base64 注入 CI，secret `WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD` 已配置 | 不适用（secret 已配置） | 自签证书只在生成它的那台机器的受信根证书 / 受信发布者列表里；其他未导入该证书的机器上，SmartScreen 仍按「未知发布者」处理。签名不能消除这个提示 | 安装包经 electron-updater 自动下载安装（Windows 读 `latest.yml`） |
| macOS（`target: zip`，arm64 / x64） | 沿用上游 DS Bot 做法：`target: zip` 出包，ad-hoc 签名（`identity: '-'`），只封牢 bundle；不做 Developer ID 签名，不做公证，不需要 Apple Developer 账号 | 无开发者证书；DSH 自带的 Computer Use helper 保留它自己的签名，其余由 ad-hoc 封口 | 无 | 不适用 | Gatekeeper 首次打开拦下，提示「无法验证开发者」，不是「已损坏」；到「系统设置 → 隐私与安全性」点「仍要打开」放行。不要关闭 Gatekeeper | 不自动安装。启动时和每 4 小时查 GitHub Releases，发现新版提示后打开 Releases 下载页，由用户手动下载替换 |
| Linux（AppImage / deb，x64） | 未签名 | 无 | 无 | 不适用 | 包本身没有签名校验；AppImage 下载后需加可执行位再运行，deb 走 apt 安装 | AppImage 可自更新（读 `latest-linux.yml`）；deb 不自更新，提示后跳 Releases 下载页 |
| Android（release APK） | 上传密钥签名，v1（JAR）+ v2 + v3 三种签名方案全开 | 上传密钥 keystore（`upload.jks`，alias `upload`），由维护者生成并离线备份；secret `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 已配置 | 不适用（secret 已配置） | 同一把上传密钥签出的 APK 才能覆盖安装；换密钥后 Android 拒绝覆盖。Android 14+ 的通知权限 `POST_NOTIFICATIONS` 已在 App 配置中声明 | APK 内检查 Releases，按 `Anbot-<版本>-android.apk` 资产名匹配并校验 `SHA256SUMS.txt` 摘要后下载更新 |
| iOS | 需要 Apple Developer Program 账号、Team ID 和 App Store Connect API key 才能签名出包 | 当前无 Apple 账号；CI 只构建无签名的模拟器包（`CODE_SIGNING_ALLOWED=NO`），不产出可安装的 `.ipa` | 本地脚本环境变量：`DS_BOT_APPLE_TEAM_ID`、`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` | 脚本检测到缺项直接退出（退出码 2） | 无对外包。账号、App ID、API key 的准备步骤见 [`docs/plans/2026-11-13-ios-release.md`](../plans/2026-11-13-ios-release.md) | 不适用 |

补充事实：

- Windows 安装包由发版工作流在 Windows runner 上用注入的 PFX 做 Authenticode 签名；当前自签证书没有经过商业 CA 背书，**不要**在文档或 Release 说明里写成「公开受信」「已消除 SmartScreen 提示」。
- macOS 发 zip 不发 dmg：macOS 26 会把下载来的未签名 dmg 判为损坏且打不开，ad-hoc 签名对 dmg 也没有帮助。
- 仓库是公开仓库，匿名即可访问 Releases API；macOS、deb 和 App 内的更新检查在请求失败（网络不可达、接口报错等）时记为「检查失败」，而不是「已是最新」。需要指向其他更新源做无人值守更新时，通过 `ANBOT_UPDATE_URL`（兼容旧名 `DS_BOT_UPDATE_URL`）指向可访问的更新源。
- v0.0.1 随附 Windows 安装包与 Android APK：Windows 用 CI 注入的项目自签 PFX 做 Authenticode 签名；Android 用上传 keystore（alias `upload`）签名。两者证书/密钥都不是商业 CA 背书：Windows 自签证书在其他机器上仍显示未知发布者。
- v0.0.1 本次发布不含 iOS 可安装包：没有 Apple Developer Program 账号、Team ID 与 App Store Connect API key，CI 只做无签名模拟器编译，不产出也不上传 `.ipa` / TestFlight 包；后续账号材料齐备前，不要把 iOS 写成已支持或即将放出的下载项。

### 1.1 Windows 证书入库

Windows 任务从 `WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD` 两个 secret 取 PFX。下面是把本机证书存储里的证书导出、转 base64、写入 secret 的完整步骤。

**前提**：证书已经在这台机器的当前用户证书存储里，且带可导出的私钥（`HasPrivateKey = True`）。查看：

```powershell
Get-ChildItem Cert:\CurrentUser\My | Format-List Subject,Thumbprint,HasPrivateKey,NotAfter
```

**导出 PFX**：口令自定，只用于这次传输，不写进仓库、不进聊天：

```powershell
$pwd = ConvertTo-SecureString -String '<一次性口令>' -AsPlainText -Force
Export-PfxCertificate -Cert (Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq '<指纹>') -FilePath upload.pfx -Password $pwd
```

**转单行 base64 并写 secret**：

- macOS：

  ```sh
  base64 -i upload.pfx | tr -d '\n' > upload.txt
  ```

- Windows / Linux：

  ```sh
  base64 -w0 upload.pfx > upload.txt
  ```

  然后用 GitHub CLI 写入仓库 secret（第二个命令交互输入口令，不要把口令写在命令行里）：

  ```sh
  gh secret set WINDOWS_CERTIFICATE_BASE64 < upload.txt
  gh secret set WINDOWS_CERTIFICATE_PASSWORD
  ```

**收尾**：`upload.pfx` 和 `upload.txt` 用完立刻删除——Windows：`Remove-Item upload.pfx,upload.txt`；Linux / macOS：`rm -f upload.pfx upload.txt`。这两个文件绝不进仓库、不进聊天记录；仓库里只保留 secret。

**信任状态与注入无关**：证书是否被其他机器公开信任，取决于证书链本身，与 secret 注入是否正确无关。自签证书即使正确注入 CI，其他未导入该证书的机器首次运行仍提示「未知发布者」。维护者若愿意，可以只导出含公钥的 `.cer` 公开发布，由用户自行导入到「受信任的根证书颁发机构」后本机才受信；这属于用户自行选择的进阶操作，不作为默认放行步骤推荐。

**本机实测记录**：在本机用 `Export-PfxCertificate` 成功导出 PFX（3446 字节，私钥可导出）；用它给一个测试 exe 签名后，`Get-AuthenticodeSignature` 为 `Valid`，签名者 `CN=Anbot Release Signing`。本机给测试 exe 打 RFC 3161 时间戳时报 `0x80072efd`（本机代理导致的连接失败；curl 探测时间戳端点本身是通的），时间戳是否加上要在 CI 上按 §4.1 的步骤实测，不在本机结论里写成已验证。

## 2. 首次安装：会看到什么，怎么放行

下面的提示都属于「本机是否信任这个发布者」的问题，**不代表安装包被篡改**。包是否完整，用第 2.4 节的 `SHA256SUMS.txt` 校验。

### 2.1 Windows

1. 从 Release 页下载 `Anbot-<版本>-win-x64.exe`。
2. 双击运行。未导入自签证书的机器上，SmartScreen 显示「Windows 已保护你的电脑」，发布者一栏为「未知发布者」。
3. 点「更多信息」→「仍要运行」，再按安装向导操作。安装只针对当前用户，不需要管理员权限。
4. 放行后同一台机器上再次运行不再重复提示。

不要为了绕过提示去关闭 SmartScreen 或降低系统安全级别。

### 2.2 macOS

1. 用 Safari 从 Release 页下载对应芯片的 zip（Apple 芯片 `Anbot-0.0.1-mac-arm64.zip`，Intel `Anbot-0.0.1-mac-x64.zip`；Safari 会自动解压），把 Anbot 拖到「应用程序」。
2. 第一次打开，Gatekeeper 拦下：提示无法验证开发者（不应出现「已损坏」；若出现「已损坏」，先核对下载的 zip 是否完整，见 2.4）。
3. 打开「系统设置 → 隐私与安全性」，在安全提示旁点「仍要打开」，再在弹窗里确认。
4. 放行后同一台机器上再次打开不再重复提示。

不要用 `spctl --master-disable` 之类的命令整体关闭 Gatekeeper。

### 2.3 Android

1. 从 Release 页下载 `Anbot-<版本>-android.apk`。浏览器或文件管理器首次安装来自 Release 的 APK 时，需要允许该来源「安装未知应用」。
2. Google Play Protect 可能对未在 Play 商店分发的 APK 给出提示；核对包名、版本和第 2.4 节的校验和后继续安装。
3. 安装打开后，按引导扫码配对。通知权限在 Android 14+ 上会首次运行时申请（`POST_NOTIFICATIONS` 已声明）。
4. 覆盖安装必须用同一把上传密钥签出的包；换签名密钥后先卸载再装。

### 2.4 校验 SHA256SUMS.txt

每个 Release 附带 `SHA256SUMS.txt`，列出该版本全部安装包的 SHA-256 校验和。下载安装包后先比对，再安装：

- Windows（PowerShell）：

  ```powershell
  Get-FileHash .\Anbot-<版本>-win-x64.exe -Algorithm SHA256
  ```

- macOS：

  ```sh
  shasum -a 256 Anbot-0.0.1-mac-arm64.zip   # Intel 机用 Anbot-0.0.1-mac-x64.zip
  ```

- Linux：

  ```sh
  sha256sum Anbot-<版本>-linux-x86_64.AppImage   # deb 同理：Anbot-<版本>-linux-amd64.deb
  ```

- Android：

  ```sh
  sha256sum Anbot-<版本>-android.apk
  ```

把输出的 64 位十六进制值与 `SHA256SUMS.txt` 里同名文件那一行比对，一致即为完整。校验和覆盖 APK 与各桌面包。校验和不匹配时不要安装，先从 Release 页重新下载；仍不匹配则在 Issue 里报告。

## 3. Android 上传密钥：生成、入库与本地出包

### 3.1 生成上传密钥

在一台受信任的机器上（JDK 17，与 CI 一致）执行：

```sh
keytool -genkeypair -v \
  -keystore upload.jks \
  -alias upload \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```

按提示填写口令和证书信息。别名用 `upload`；如果密钥口令与 keystore 口令不同，单独记下——当前 CI 没有传 `DSBOT_ANDROID_KEY_PASSWORD`，默认两者相同，建议保持一致。

### 3.2 转 base64 并写入 secret

把 keystore 文件转成单行 base64：

- Linux：

  ```sh
  base64 -w0 upload.jks
  ```

- macOS：

  ```sh
  base64 -i upload.jks | tr -d '\n'
  ```

把结果写入仓库的三个 GitHub secret：

| secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 上一步的单行 base64 整段 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | `upload` |

### 3.3 不可更换与保管规则

- **密钥一旦用于发版就不能更换。** 以后的每个 release APK 都必须用这把密钥签；换密钥后，已安装的用户无法覆盖安装（Android 判定为不同应用）。
- 本地日常调试（`expo run:android`、模拟器）**不要**配上这把上传密钥；只有出可分发的 release 包时才使用。
- `upload.jks`、口令、base64 文本绝不进仓库、Issue、PR 评论、日志和聊天。离线备份一份在安全处；密钥丢失等于已发布的 App 无法再出可覆盖安装的更新包。

### 3.4 本地出可安装的 release 包

在 `mobile/` 目录，先 prebuild 生成 Android 工程，再带上密钥环境变量构建：

```sh
cd mobile
npx expo prebuild --platform android --no-install

export DSBOT_ANDROID_KEYSTORE=/path/to/upload.jks
export DSBOT_ANDROID_KEYSTORE_PASSWORD='<keystore 口令>'
export DSBOT_ANDROID_KEY_ALIAS=upload
# 仅当密钥口令与 keystore 口令不同时再设：
# export DSBOT_ANDROID_KEY_PASSWORD='<密钥口令>'

(cd android && ./gradlew assembleRelease --no-daemon --build-cache --console=plain \
  -PreactNativeArchitectures=arm64-v8a,armeabi-v7a)
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`。环境变量名与 `mobile/plugins/android-release-signing.js` 的注释一致：`DSBOT_ANDROID_KEYSTORE`、`DSBOT_ANDROID_KEYSTORE_PASSWORD`、`DSBOT_ANDROID_KEY_ALIAS`、`DSBOT_ANDROID_KEY_PASSWORD`（可选）。

## 4. 验证签名

### 4.1 Windows

PowerShell：

```powershell
Get-AuthenticodeSignature .\Anbot-<版本>-win-x64.exe
```

核对三点：签名不是 `NotSigned`；`SignerCertificate.Subject` 非空（如实记录发布者名称）；`TimeStamperCertificate` 存在（即带 RFC 3161 时间戳）。

`Status` 的判定分两种情况：商业 CA 证书在受信机器上应为 `Valid`；当前的自签证书在未导入它的机器（包括 CI runner）上链不到受信 CA，`Status` 可能是 `UnknownError` 或 `NotTrusted`，这属于预期，不按失败处理。不要把 `Status=Valid` 当作自签包的硬性门槛。

用 Windows SDK 的 signtool 复核完整链（仅商业 CA 证书能通过 `/pa` 链校验；自签证书会在这一步断链，属预期）：

```sh
signtool verify /pa /all Anbot-<版本>-win-x64.exe
```

### 4.2 macOS

zip 先解压到「应用程序」，再校验 bundle：

```sh
codesign -dv --verbose=4 /Applications/Anbot.app
```

ad-hoc 签名没有受信颁发者链；输出能确认 bundle 被封口、标识和签名状态即可。

### 4.3 Android

```sh
apksigner verify --min-sdk-version 21 --verbose --print-certs Anbot-<版本>-android.apk
```

输出应同时包含 v1、v2、v3 三种方案的 verified 记录，以及证书的 DN 和 SHA-256 指纹；`--min-sdk-version 21` 会一并校验 v1 JAR 签名。Release 包证书 DN 应为上传密钥证书；出现 `CN=Android Debug` 即说明签错了密钥。

### 4.4 时间戳为什么必须存在

Windows Authenticode 签名必须加盖 RFC 3161 时间戳（当前配置为 DigiCert 的 `http://timestamp.digicert.com`，摘要 SHA-256）。没有时间戳时，验证方只能凭「证书当前是否在有效期内」判断签名；证书一旦过期，此前签好的旧包就无法再通过验证。盖上时间戳后，签名被证明发生在证书有效期内，即使证书后来过期，已签的旧包仍然可信。检查 Windows 包签名时，确认签名详情里带时间戳，而不只是有签名块。

## 5. 不要做的事

- 不要为了消除系统提示去购买、借用或冒用他人的代码签名证书，也不要在发布者名称上冒充其他产品。证书主体必须与 Anbot 的项目身份一致。
- 不要把 keystore、PFX/P12、私钥、证书口令、Apple API key 写进仓库、Issue、PR 评论、日志、截图或聊天记录；密钥只存 GitHub Secrets 和离线备份。
- 不要用上传密钥签本地调试包，也不要把调试签名的包发到 Release。
- 不要整体关闭 Gatekeeper、SmartScreen 或 Play Protect 来绕过提示；按本文的「仍要打开 / 仍要运行」单包放行即可。
- 不要在未核对 `SHA256SUMS.txt` 的情况下，从第三方镜像或转发链接安装包。
