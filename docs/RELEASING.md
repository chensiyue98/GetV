# GitHub Actions 发布配置

`.github/workflows/release.yml` 会完成以下工作：

1. 构建同时支持 Apple Silicon 和 Intel 的 macOS App。
2. 使用 Developer ID Application 证书签名。
3. 将签名 App 提交 Apple 公证并装订公证票据。
4. 创建或更新 GetV 的 GitHub Release。
5. 计算 ZIP 的 SHA-256，并更新 `chensiyue98/homebrew-tap` 中的 Cask。

## 首次配置 Secrets

在 GetV 仓库的 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 内容 |
| --- | --- |
| `DEVELOPER_ID_CERTIFICATE_BASE64` | 含私钥的 Developer ID Application `.p12` 文件的 Base64 |
| `DEVELOPER_ID_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_KEY_BASE64` | App Store Connect API `.p8` 文件的 Base64 |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID |
| `APPLE_API_ISSUER_ID` | App Store Connect Issuer ID |
| `HOMEBREW_TAP_TOKEN` | 对 `chensiyue98/homebrew-tap` 具有 Contents 读写权限的 fine-grained PAT |

在 macOS 上可用以下命令生成 Base64，输出会直接复制到剪贴板：

```sh
base64 < DeveloperID.p12 | pbcopy
base64 < AuthKey_XXXXXXXXXX.p8 | pbcopy
```

`GITHUB_TOKEN` 由 Actions 自动提供，用于创建 GetV Release，不需要手动添加。

## 发布

发布版本以手动输入或 Git 标签为准，可使用以下任一方式：

- 在 GitHub 的 **Actions → Release → Run workflow** 中输入 `1.2`。
- 推送发布标签：`git tag v1.2 && git push origin v1.2`。

工作流会在构建前自动同步所有 Xcode target 的 `MARKETING_VERSION` 和扩展 manifest 版本（例如 `1.2` 对应 `1.2.0`），Release 和 Homebrew Cask 使用同一发布版本。只支持 `major.minor` 或 `major.minor.patch` 纯数字版本，每段不超过 65535，不接受 `v` 前缀的手动输入或 `-beta` 等后缀。同步仅发生在 CI 工作目录，不会自动提交回仓库；`CURRENT_PROJECT_VERSION` 保持不变。

修改 workflow 后，需要从包含修复的分支重新点击 **Run workflow**；旧失败任务的 **Re-run jobs** 仍可能使用旧提交中的 workflow。发布完成后，用户可运行：

```sh
brew tap chensiyue98/tap
brew install --cask get-v
```
