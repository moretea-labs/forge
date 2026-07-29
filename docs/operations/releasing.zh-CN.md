# 发布 repo-harness

公开 npm 包名为 `@moretea-labs/repo-harness-controller`，安装后提供稳定命令 `repo-harness` 与 `repo-harness-hook`。

## 当前状态

npm 包目前尚未公开。下一条候选基线是 `1.4.0-rc.6`，首个稳定版目标是 `1.4.0`。首次 npm 发布前，公开文档必须把源码安装作为当前可用路径，并明确标注 registry 安装命令尚未开放。

## 分发模型

1. **npm** 是 CLI artifact 的主要 registry 和版本权威。
2. **Bun** 直接安装或执行同一个 npm 包，不需要单独发布 Bun 包。
3. **GitHub Releases** 为对应 Git tag 提供发布说明和不可变发布身份。
4. **Homebrew** 只在稳定版存在后，通过 Moretea Labs tap 提供。

RC 使用 npm dist-tag `next`，稳定版使用 `latest`。

## 本地发布门禁

在目标 release commit 的干净 checkout 中执行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check:release-version
npm run check:release-readiness
npm run release:dry-run
```

同时验证两种启动路径：

```bash
node bin/repo-harness.mjs --help
bun bin/repo-harness.mjs --help
```

门禁会检查 package 身份、公开文档、许可证与 notices、tracked 文件卫生、MCP 兼容性、公开导出内容、npm pack 结果和隔离 tarball 安装。

## 首次 npm 发布

一个尚不存在的 package 不能预先配置 npm Trusted Publishing。因此首次发布需要拥有 `@moretea-labs` scope 权限并开启双因素认证的 npm maintainer。

```bash
npm login
npm whoami
npm access ls-packages @moretea-labs

# 先创建并检查本地 tag，发布成功前不要 push。
git tag -a v1.4.0-rc.6 -m "repo-harness 1.4.0-rc.6"
RELEASE_TAG=v1.4.0-rc.6 npm run release:rc
```

发布失败时，删除尚未 push 的本地 tag，修复后重新跑完整门禁。仓库内容变化后必须产生新的 release commit。已经发布的 npm 版本不能覆盖，已经 push 的 release tag 不能移动。

npm 确认发布成功后：

```bash
git push origin v1.4.0-rc.6
gh release create v1.4.0-rc.6 --verify-tag --generate-notes --prerelease
npm run check:release-published
```

## Bootstrap 后启用 Trusted Publishing

首个 package 存在后：

1. 在 npm 中为 `moretea-labs/repo-harness-controller-runtime` 与 `.github/workflows/release.yml` 配置 Trusted Publishing。
2. 创建 GitHub environment `npm-publish`，设置 maintainer 审批。
3. 保护 `main` 与 release tags。
4. 只有完整门禁通过后，才 push 精确的 `v<package-version>` tag。

Tag workflow 使用 GitHub OIDC，不需要 `NODE_AUTH_TOKEN` 或仓库内 npm token。它会校验 tag、RC 到 `next`、稳定版到 `latest`，然后发布 package 并创建对应 GitHub Release。

## 稳定版要求

发布 `1.4.0` 前：

- 在 macOS、Linux、WSL2 和已声明的 Windows 路径安装精确 packed artifact；
- 验证 `repo-harness init`、`doctor`、仓库注册/接入和 ChatGPT MCP 连接；
- 确认稳定文档中没有 RC 专属警告或不稳定安装命令；
- 把 `package.json` 改为 `1.4.0`，package identity gate 会要求 `latest`；
- 从受保护环境发布 tag `v1.4.0`；
- 完成后才创建或更新 Homebrew tap formula。

## 回滚与事故规则

npm 版本和已 push 的 release tag 都是不可变的。错误版本不能覆盖发布：必要时 deprecate 该 npm 版本、记录事故、恢复之前的 dist-tag，并发布新的 patch 或 RC。
