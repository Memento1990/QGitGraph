# 0.2.0 Release checklist

## Implementation and automated gates

- [x] Freeze public behavior sources and independent-source boundary.
- [x] Versioned schema, v1→v2 preference-preserving migration, leaf overrides and global-only Git path.
- [x] Multi-ref/glob history, tag/stash/contains/submodule metadata, graph projection and actual HEAD.
- [x] Inline details, safe inline messages/gitmoji, review lifecycle, navigation, provider URLs, full settings/actions.
- [x] Explicit verification, trusted environment policy, real process-tree cancellation and output limit recovery.
- [x] Frontend 71 tests; Rust unit53 + Git integration60, all with actual logs; final integration command explicitly enables `host-tests -- --nocapture`, and SSH prerequisites cannot silently skip.
- [x] Clippy warnings denied with `host-tests --all-targets`, production build and no sample data in production resources.
- [x] Strict run-owned real desktop baseline and parity suites; unique UI-created refs and full repository integrity.
- [x] True native folder picker/cancel and configuration export; console successful/paused lifecycle; terminal input/output/exit.
- [x] Full notice text, exact MPL archives and regenerated input hashes.
- [x] Final fixed-binary NSIS installation/tree verification: 836 notice entries, all covered-source archives, no host-test probe, complete witnessed uninstall; `install-final-03`.
- [x] Exact installed executable retained and SHA-matched real desktop parity repeated; `release-payload-final`.
- [x] Final installed-payload resource report: 75.775s idle / 5 snapshots, corrected 61.512s CPU window, full app+WebView2 footprint; `resources-payload-final`.
- [x] Six extra release-contract regressions (26 helper tests total); strict kind/schema, required-blocked rejection, parity/CPU duration and exact Cargo host-test targets, no SHA/freshness relaxation.
- [x] 20,000 real commits / 4 merges / 8 refs: first300, +100/+100, message/hash search beyond loaded history, exact OIDs and full after-cleanup repository/config integrity; `large-history-final-03`. UI cancellation remains explicitly optionalblocked, not counted as passing.
### ZIP staging result

ZIP creation is the final action after source/document freeze, so this source checklist does not self-certify a not-yet-created archive. The authoritative completed result is the sibling `stage-result.json` (`status: passed`) plus `manifest.json` and `SHA256SUMS.txt` in `release/QGitGraph-0.2.0/`; staging verifies every source/binary ZIP entry and records exact hashes. A failed or absent stage result is not a release approval.

## Build-only probe exclusion

`qgitgraph-test-probe` and `host_parity` are gated behind `host-tests`. Release builds must not enable that feature. Tauri installer script and installed file tree must contain no test probe. Full test command uses `--features host-tests`; normal packaging explicitly selects the main binary.

## Actual environment gates, not code tasks

- [ ] Windows10 22H2, clean VM with missing Git/WebView2, offline runtime install.
- [ ] Real100/150/200% DPI/multimonitor/screenreader matrix.
- [ ] Real user-owned test HTTPS/GCM/SSO and SSH agent/server flows.
- [ ] GPG/X.509 toolchains and PKI/signing devices; temporary OpenSSH crypto tests are not their substitute.
- [ ] Actual hosting-provider PR form permissions/current webpage behavior.
- [ ] Authenticode certificate, SmartScreen/reputation and final native runtime/CRT/NSIS legal review.

No production secret, global Git rewrite, TLS/host-key bypass, runtime uninstall, upload/push/publication is authorized by local testing.

Shared clipboard tests restore saved text and refuse non-text content; inability to access shared clipboard is blocked, not reason to overwrite or silently clear it. Native application/profile and installer registration are separate isolation scopes.
