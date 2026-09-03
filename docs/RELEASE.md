# 发包与发行版

协作（Spec / commit）见 [DEVELOPMENT.md](../DEVELOPMENT.md)。npm 包名是 **[homegraph](https://www.npmjs.com/package/homegraph)**。

## Remotes（本仓库约定）

| remote | URL | 用途 |
| --- | --- | --- |
| `github` | https://github.com/fujiaxin-coder/homegraph | **正式发包**：Actions Release → GitHub Release + `npm publish` |
| `origin` | GitCode（如 `SMAT/HomeGraph`） | 日常协作 / 镜像；网页「新建发行版」可选 |

本地准备好 version + CHANGELOG + annotated tag 后，**同一批**推两个 remote 的 `main` 与 `vX.Y.Z`，再在 GitHub 上跑 Release workflow。

## npm（正式发包）

在本地把版本、CHANGELOG、tag 一次准备好，**审完再一起推**；Actions 只负责测通后打 GitHub Release 并 `npm publish`。

1. 要发布的改动已在 `main`；`CHANGELOG.md` 的 `## [Unreleased]` 写好用户向说明（**不要**手建 `## [X.Y.Z]`）。
2. 把 `package.json`（及 `package-lock.json`）的 `version` 改成目标版，commit（如 `release: bump version to X.Y.Z`，`-s`）。
3. 本地提升 CHANGELOG：`node scripts/prepare-release.mjs`（读 `package.json` 的 version）。脚本会把 `[Unreleased]` 升成 `[X.Y.Z] - YYYY-MM-DD` 并追加一条链接；**把脚注链接改成 GitHub Release**（`https://github.com/fujiaxin-coder/homegraph/releases/tag/vX.Y.Z`）。历史条目若仍指向 GitCode tags 可保留不动。
4. commit CHANGELOG（如 `docs(changelog): promote Unreleased into X.Y.Z`，`-s`），再打 **annotated** tag：`git tag -a vX.Y.Z -m "vX.Y.Z"`（指到该 promote commit）。
5. 确认无误后 **一起**推（不要只推 version bump、也不要先空推 main 再补 tag）：

   ```bash
   git push origin main && git push origin vX.Y.Z
   git push github main && git push github vX.Y.Z
   ```

6. GitHub → [Actions → Release](https://github.com/fujiaxin-coder/homegraph/actions/workflows/release.yml) → Run workflow（`main`）。已本地 promote 时 workflow 的 CHANGELOG 步骤会 no-op；它创建/更新 GitHub Release 并 publish npm。**不要**本地 `npm publish`。

Secrets（仓库 **Settings → Secrets**，挂在 `fujiaxin-coder/homegraph`）：`NPM_TOKEN`、`RELEASE_PAT`（见 `.github/workflows/release.yml`）。

CHANGELOG：写能力/修了什么；分组 `New Features` / `Fixes`；少写内部路径。版本块用 `scripts/prepare-release.mjs` 提升，不要手改标题。

## GitCode「新建发行版」

网页上选对应 Tag、写标题/描述（可从 CHANGELOG 粘）即可；**不必**从 GitHub 再下载上传。
