# 发包与发行版

协作（Spec / commit）见 [DEVELOPMENT.md](../DEVELOPMENT.md)。npm 包名是 **[homegraph](https://www.npmjs.com/package/homegraph)**。

## npm（正式发包）

在本地把版本、CHANGELOG、tag 一次准备好，**审完再一起推**；Actions 只负责测通后打 GitHub Release 并 `npm publish`。

1. 要发布的改动已在 `main`；`CHANGELOG.md` 的 `## [Unreleased]` 写好用户向说明（**不要**手建 `## [X.Y.Z]`）。
2. 把 `package.json`（及 `package-lock.json`）的 `version` 改成目标版，commit（如 `release: bump version to X.Y.Z`，`-s`）。
3. 本地提升 CHANGELOG：`node scripts/prepare-release.mjs`（读 `package.json` 的 version）。脚本会把 `[Unreleased]` 升成 `[X.Y.Z] - YYYY-MM-DD` 并追加一条链接；**把链接改成 GitCode**（与文末现有 `[1.5.x]: https://gitcode.com/ProgramAnalysis/homegraph/tags/…` 一致；脚本默认写的是 upstream GitHub）。
4. commit CHANGELOG（如 `docs(changelog): promote Unreleased into X.Y.Z`，`-s`），再打 **annotated** tag：`git tag -a vX.Y.Z -m "vX.Y.Z"`（指到该 promote commit）。
5. 确认无误后 **一起**推：`git push origin main` 与 `git push origin vX.Y.Z`（不要只推 version bump、也不要先空推 main 再补 tag）。
6. GitHub → Actions → **Release** → Run workflow（`main`）。已本地 promote 时 workflow 的 CHANGELOG 步骤会 no-op；它创建/更新 GitHub Release 并 publish npm。**不要**本地 `npm publish`。

Secrets：`NPM_TOKEN`、`RELEASE_PAT`（见 `.github/workflows/release.yml`）。

CHANGELOG：写能力/修了什么；分组 `New Features` / `Fixes`；少写内部路径。版本块用 `scripts/prepare-release.mjs` 提升，不要手改标题。

## GitCode「新建发行版」

网页上选 Tag、写标题/描述（可从 CHANGELOG 粘）即可。
