# 发包与发行版

协作（Spec / commit）见 [DEVELOPMENT.md](../DEVELOPMENT.md)。npm 包名是 **[homegraph](https://www.npmjs.com/package/homegraph)**。

## npm（正式发包）

1. 要发布的改动已在 `main`；`CHANGELOG.md` 的 `## [Unreleased]` 写好用户向说明（**不要**手建 `## [X.Y.Z]`）。
2. 把 `package.json` 的 `version` 改成目标版。
3. GitHub → Actions → **Release** → Run workflow（`main`）。
4. **不要**本地 `npm publish` / 随便打发版 tag。

Secrets：`NPM_TOKEN`、`RELEASE_PAT`（见 `.github/workflows/release.yml`）。

CHANGELOG：写能力/修了什么；分组 `New Features` / `Fixes`；少写内部路径。版本块由 workflow 的 `prepare-release.mjs` 提升。

## GitCode「新建发行版」

网页上选 Tag、写标题/描述（可从 CHANGELOG 粘）即可。