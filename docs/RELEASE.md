# 发包与发行版

协作（Spec / commit）见 [DEVELOPMENT.md](../DEVELOPMENT.md)。npm 包名是 **[homegraph](https://www.npmjs.com/package/homegraph)**。

## Remotes（本仓库约定）

| remote | URL | 用途 |
| --- | --- | --- |
| `github` | https://github.com/fujiaxin-coder/homegraph | **正式发包**：先推 `main`，发包成功后再推 tag |
| `origin` | GitCode（如 `SMAT/HomeGraph`） | 日常协作 / 镜像。版本提交先不推；tag 在发包成功后与 `github` 一起推 |

## npm（正式发包）

版本号和 CHANGELOG 放在**同一次** commit 里。这个 commit **只**推 `github` 的 `main`。**先不要打 tag**，也不要推 `origin`。维护者确认包已经发出去之后，再打 annotated tag，并把 tag 推到 `github` 和 `origin`。

1. 要发布的改动已在 `main`。`CHANGELOG.md` 的 `## [Unreleased]` 写好用户向说明。
2. 把 `package.json` 和 `package-lock.json` 的 `version` 改成目标版。
3. 本地提升 CHANGELOG：`node scripts/prepare-release.mjs`（读 `package.json` 的 version）。脚本会把 `[Unreleased]` 升成 `[X.Y.Z] - YYYY-MM-DD` 并追加一条链接；脚注指向 GitHub Release（`https://github.com/fujiaxin-coder/homegraph/releases/tag/vX.Y.Z`）。历史条目若仍指向 GitCode tags 可保留不动。
4. 把版本号、CHANGELOG、以及本文件里有变的发包步骤放进**一个** commit（如 `release: prepare X.Y.Z`，`-s`）。
5. 只推 GitHub 的 `main`，不推 tag，不推 `origin`：

   ```bash
   git push github main
   ```

6. 维护者发包并确认成功后，在该 commit 上打 **annotated** tag，再把 tag 推到两个 remote。`main` 若当时没推过 `origin`，一并推上：

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push github vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

GitHub Actions 的 [Release](https://github.com/fujiaxin-coder/homegraph/actions/workflows/release.yml) workflow 仍会在 `npm publish` 之前执行 `gh release create`，那一步会自己创建 tag。按上面的顺序发包时不要靠它来打 tag；本地 `npm publish` 也不要在 tag 之前做，除非维护者明确说这次由自己发包、成功后再补 tag。

Secrets（仓库 **Settings → Secrets**，挂在 `fujiaxin-coder/homegraph`）：`NPM_TOKEN`、`RELEASE_PAT`（见 `.github/workflows/release.yml`）。

CHANGELOG：写能力/修了什么；分组 `New Features` / `Fixes`；少写内部路径。版本块用 `scripts/prepare-release.mjs` 提升，不要手改标题。

## GitCode「新建发行版」

网页上选对应 Tag、写标题/描述（可从 CHANGELOG 粘）即可；**不必**从 GitHub 再下载上传。Tag 要等发包成功并推到 `origin` 之后才有。
