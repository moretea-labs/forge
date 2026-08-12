# 发布 Forge

公开 npm 包名为 `@moretea-labs/forge`，只发布 `forge`、`forge-hook` 与 `forge-runtime`，不再发布此前产品的命令别名。

## 当前发布模型

`@moretea-labs/forge` 的候选版本发布到 npm `next`，稳定版本发布到 `latest`。发布文档不硬编码“下一版本”；版本、Git tag、npm channel 和 GitHub Release 必须从 `package.json` 的当前版本推导并保持一致。

## 分发模型

1. **npm** 是 CLI artifact 的主要 registry 和版本权威。
2. **Bun** 直接安装或执行同一个 npm 包，不需要单独发布 Bun 包。
3. **GitHub Releases** 为对应 Git tag 提供发布说明和不可变发布身份。
4. **Homebrew** 只在稳定版存在后，通过 Moretea Labs tap 提供。

RC 使用 npm dist-tag `next`，稳定版使用 `latest`。`publishConfig.provenance` 始终保持启用；发布 channel 由受保护的命令或 workflow 显式选择。

## 本地发布门禁

在目标 release commit 的干净 checkout 中执行：

```bash
bun install --frozen-lockfile
bun run check:main
bun run check:release
```

同时验证两种启动路径：

```bash
node bin/forge.mjs --help
bun bin/forge.mjs --help
```

main 门禁复用 focused task receipt，不执行全量测试。release 门禁复用该 receipt，检查 package 身份、公开文档、许可证与 notices、tracked 文件卫生和公开导出内容，然后只在 `.ai/harness/artifacts/release/` 生成一个 tarball；隔离安装与发布都复用这个 tarball。`test:full` 仅作为人工诊断命令。

## npm 首次发布（仅 package 尚不存在时）

一个尚不存在的 package 不能预先配置 npm Trusted Publishing。因此首次发布需要拥有 `@moretea-labs` scope 权限并开启双因素认证的 npm maintainer。由于这条一次性的本机 bootstrap 路径没有 OIDC provider，`NPM_RELEASE_BOOTSTRAP=1` 只对这次首发关闭 provenance；正常 GitHub OIDC 发布仍保持 `publishConfig.provenance=true`。

```bash
npm login
npm whoami
npm access ls-packages @moretea-labs

# 先创建并检查本地 tag，发布成功前不要 push。
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${VERSION}" -m "Forge ${VERSION}"
NPM_RELEASE_BOOTSTRAP=1 RELEASE_TAG="v${VERSION}" npm run release:rc
```

发布失败时，删除尚未 push 的本地 tag，修复后重新跑完整门禁。仓库内容变化后必须产生新的 release commit。已经发布的 npm 版本不能覆盖，已经 push 的 release tag 不能移动。

npm 确认发布成功后：

```bash
git push origin "v${VERSION}"
gh release create "v${VERSION}" --verify-tag --generate-notes --prerelease
npm run check:release-published
```

## Bootstrap 后启用 Trusted Publishing

首个 package 存在后：

1. 在 npm 中为 `moretea-labs/forge` 与 `.github/workflows/release.yml` 配置 Trusted Publishing。
2. 创建 GitHub environment `npm-publish`，设置 maintainer 审批。
3. 保护 `main` 与 release tags。
4. 只有完整门禁通过后，才 push 精确的 `v<package-version>` tag。

Tag workflow 使用 GitHub OIDC，不需要 `NODE_AUTH_TOKEN` 或仓库内 npm token。它会校验 tag、RC 到 `next`、稳定版到 `latest`。如果精确版本已经由首次 bootstrap 发布到 npm，workflow 会跳过重复 publish 并继续创建 GitHub Release；后续新版本则通过 Trusted Publishing 正常发布。

## 稳定版要求

发布 `1.4.0` 前：

- 在 macOS、Linux、WSL2 和已声明的 Windows 路径安装精确 packed artifact；
- 验证 `forge init`、`forge doctor`、仓库注册/接入和 ChatGPT MCP 连接；
- 确认稳定文档中没有 RC 专属警告或不稳定安装命令；
- 把 `package.json` 从 RC 版本改为目标稳定版 `X.Y.Z`，package identity gate 会要求 `latest`；
- 从受保护环境发布 tag `v1.4.0`；
- 完成后才创建或更新 Homebrew tap formula。

## 回滚与事故规则

npm 版本和已 push 的 release tag 都是不可变的。错误版本不能覆盖发布：必要时 deprecate 该 npm 版本、记录事故、恢复之前的 dist-tag，并发布新的 patch 或 RC。
