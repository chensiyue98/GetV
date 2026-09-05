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

当前项目的 `MARKETING_VERSION` 是 `1.1`。发布可使用以下任一方式：

- 在 GitHub 的 **Actions → Release → Run workflow** 中输入 `1.1`。
- 推送与项目版本一致的标签：`git tag v1.1 && git push origin v1.1`。

工作流会拒绝与 `MARKETING_VERSION` 不一致的版本，避免 Release、App 和 Homebrew Cask 版本漂移。发布完成后，用户可运行：

```sh
brew tap chensiyue98/tap
brew install --cask get-v
```
