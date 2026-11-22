# QGitGraph v0.2.2 — Initial public release

QGitGraph is a focused Windows Git desktop client built with Tauri, Rust and native TypeScript/CSS. This is the first public GitHub release; it includes the existing feature-complete desktop workflows and performance revisions, plus manual GitHub release checks.

## Highlights

- Commit graph with multiple-ref/glob scopes, history search, stash semantics, branch/tag metadata, comparison and inline details.
- Read-only unified/split Diff, lazy old/new file content, explicit review sessions and keyboard navigation.
- Branch/tag/stash/remote operations with trust gates, reviewed destructive actions and force-with-lease protections; external terminal/editor/diff integration.
- Performance work from 0.2.1 is retained: staged project loading, patch-first Diff, fewer Git launches, cached/virtualized models and safe Windows process isolation without global thread scans.
- **Manual update checks:** Settings → About & privacy → Check for updates. Requests only this repository's latest stable Release after a click; no automatic downloading, installation, account login or repository-data upload.
- QGitGraph-owned code is now **MIT licensed**. Complete third-party notices and exact covered-source archives accompany the installer, full binary ZIP and curated source ZIP.

## Downloads

- `QGitGraph_0.2.2_x64-setup.exe` — Windows x64 current-user installer.
- `QGitGraph-0.2.2-windows-x64.zip` — complete unpack-and-run package; retain LICENSE and the notices tree.
- `QGitGraph-0.2.2-source.zip` — curated source, tests, scripts, lockfiles and license/source material; no local profiles, test screenshots, backups, credentials or build caches.
- `SHA256SUMS.txt` and `release-manifest.json` — verify the exact downloaded asset filenames and bytes.

## Requirements and known limits

- Windows 11 x64 is validated; Windows 10 22H2 still needs its own environment acceptance.
- Install **Git for Windows 2.38+** and **Microsoft WebView2 Evergreen Runtime**. Neither Git, Node nor Chromium is bundled. If WebView2 is missing, the installer uses Microsoft's online bootstrapper; offline missing-runtime installation is not certified.
- The application/installer are currently **unsigned**; SmartScreen/reputation prompts may appear.
- WSL/UNC worktree I/O can still be slow. Useful history is displayed independently of slow status work; this is not a Linux-native Git backend.
- Real DPI/multimonitor/screen-reader, missing-runtime clean VM, provider/account and hardware/PKI environments are not represented as passed by local tests.
- Update checking is not a signature-verified self-updater. Network, certificate, rate-limit or malformed-release failures remain errors, never “up to date.”

## Verification

- **342 automated tests passed:** 142 frontend, 115 Rust unit, 85 real Git/host integration.
- **16 real desktop parity checks passed**, plus a real manual update check correctly reporting no published Release before publication.
- Exact final program hashes bind desktop, resources and actual existing-user installation upgrade evidence. User settings stayed byte-identical during upgrade.
- Package contents and covered-source/license hashes are verified; preserving notices is not a blanket legal-clearance warranty.

QGitGraph is independently implemented from public behavior specifications. It does not bundle upstream Git Graph's restricted source, styles, assets or protocol, and does not imply upstream authorization or endorsement.
