# Why `node_modules/` is committed

This repo vendors its one dependency (`js-yaml`) by committing `node_modules/`
instead of `.gitignore`-ing it. The reusable workflow runs straight from the
checked-out tree with no `npm ci` step — a normal GitHub Actions consumer
setup has no install phase before the action's code runs. If `node_modules/`
weren't in the tree, the workflow would simply fail to resolve
`require('js-yaml')` at run time. See `docs/architecture.md` ("Why plain
JavaScript") for the broader rationale.

## Bumping the dependency

Because the committed tree is what actually executes, a version bump is only
half-done if it touches `package.json`/`package-lock.json` alone — the files
under `node_modules/js-yaml/` are what ships. After bumping (including a
Dependabot PR that only touches the manifest and lockfile), run `npm ci` and
commit the resulting `node_modules/` changes in the same PR.

CI enforces this: the `test` job's drift check in `ci.yml` runs `npm ci`
(which installs strictly from `package-lock.json`, ignoring whatever is
already on disk) and then fails the build if `git status --porcelain --
node_modules package-lock.json` reports any difference. That catches both a
stale `node_modules/` and a lockfile that drifted out from under it.
