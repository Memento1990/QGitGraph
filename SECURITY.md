# Security model (0.2.2)

QGitGraph is a local Git client, not a sandbox for hostile repositories.

## Trust and process lifecycle

- Browsing uses typed commands and a trusted absolute Git executable, never shell-expanded user argv. Read-only diff/text conversion and fsmonitor are disabled; safe.directory is not broadened automatically.
- Repository configuration can invoke hooks/helpers/filter/verifier programs. Repository write/network/external-tool/explicit verification operations require trust. Checking this application's fixed public release endpoint is independent of any repository and does not grant or require repository trust.
- Background Git uses documented Windows CreateProcessW with restricted standard-handle inheritance: created suspended, attached to a kill-on-close Job Object, then resumed through the retained primary-thread handle. No PID/thread rediscovery or global thread snapshot is needed. Cancellation and output limits terminate and wait for the operation tree and bounded pipe workers; multi-process requests share one scoped cancellation token and track each owned PID. Actual Git/helper/child/grandchild lifecycle, output-boundary, Unicode/argument/environment and queue-cancellation tests verify this behavior. Explicit external future abort terminates the Job but asynchronous Drop cannot synchronously join workers; awaited completion/cancellation performs reaping and joins.
- Operations queue on common Git directory for linked worktrees; waiting requests also respond to cancellation. A bounded 30s/256-entry cancellation tombstone handles cancel arriving before command registration.
- Git writes are not transactions. Partial actions, conflicts, aborts and signing errors are reported accurately; no automatic discard/lock deletion/rollback is promised.
- Interactive rebase uses a separate authenticated loopback console session. The app receives started/running/paused/failed/completed. The transaction is released when Git exits or pauses, not when the user later exits the shell. External user sessions are not silently killed when the main window closes.

## Local host boundary

- Only the bundled main page receives explicit business permissions. No arbitrary shell, executable, argv, file read/write, or remote-origin IPC is exposed.
- CSP, navigation and new-window restrictions remain in place. Repository text becomes safe DOM/TextNodes, never raw HTML.
- Inline Markdown has bounded work/depth/token limits. Issue matching uses a numeric-capture mini-language, not arbitrary user regex. Links are HTTP(S) without credentials and open only on click.
- External tools use validated absolute exe paths and token arrays with finite placeholders, no shell command strings. Working file canonical containment and readonly history snapshots are distinct operations.

## Environment and credentials

- Git routing/config/index/object overrides are removed case-insensitively. Only an explicit authentication/editor allowlist is retained for trusted operations; read-only operations do not gain it.
- GCM, SSH agent and GPG/X.509 remain user-managed. No password/private-key vault is added. TLS and SSH host-key verification are not disabled.
- URL passwords/tokens in configured network remotes are rejected by operation preflight; errors and URLs are redacted. No Git secrets are persisted in application preferences.
- Signature presence is not validity. Ordinary browsing never executes a verifier; trust-confirmed explicit verification reports actual results. Creating signatures follows a three-state policy, defaulting to Git's own configuration.

## State, sharing and review

- Local preferences store paths, trust, layout, view state and reviewed paths, not file contents or passwords. State is size/schema validated and atomically persisted; unreadable prior state is preserved with a diagnostic backup.
- v1→v2 migration keeps explicit saved preferences; global Git path cannot be silently overridden by repository/shared config.
- Shared import/export permits display/workflow settings only and requires preview. Executable paths/arguments, avatars consent, trust, credentials, recents and reviews are not imported.
- Review targets must be immutable full commit IDs. WORKTREE/INDEX comparisons cannot persist stale reviewed flags or immutable diff cache entries. Patch, lazy side-content and parsed models have entry/byte bounds; metadata fingerprints do not prove worktree content unchanged, so mutable selections use separate dirty generations.
- Performance diagnostics are startup opt-in (`--performance` or `QGITGRAPH_PERF=1`) and default off. Bounded in-memory rings record operation IDs, allowlisted Git verbs, timings/counts and outcomes only, not arguments, output or paths. The local diagnostic object can only read/reset metrics; it cannot execute host commands. Real-project performance sample plans/screenshots and upgrade backups remain local/private and are excluded from release archives.
- Avatars remain off by default; opt-in sends hashed author email identifiers and network metadata to Gravatar. Hashes are not anonymous.

## Manual release checks

- Settings → About & privacy checks updates only on an explicit button click. Startup, opening settings, and repository browsing do not initiate the request; no automatic task or persisted update preference is added.
- A parameterless business command queries only `https://api.github.com/repos/Memento1990/QGitGraph/releases/latest` through system WinHTTP. The renderer CSP remains IPC-only. No repository content, paths, Git identities, account token or application state is sent; GitHub receives ordinary IP/TLS metadata and the QGitGraph versioned User-Agent.
- TLS certificate/hostname validation remains enabled. Automatic authentication, cookies and redirects are disabled; configured system proxy failures are surfaced rather than bypassed. Native handles are RAII-owned, response bytes and release notes are bounded, and one actual blocking worker owns the singleflight guard until it exits. Finite per-phase timeouts plus elapsed deadline checks are not a hard cancellation of an already-blocked call.
- Only canonical stable SemVer releases from this exact repository are accepted. Draft/prerelease/malformed metadata, other hosts/repos, credentials/query/fragment in URLs, failed requests, rate limits and oversized responses never become “current.” A 404 means no publicly accessible latest release, not up-to-date.
- Release notes are untrusted plain text. Only a deliberate second click opens the validated official release page. No assets are automatically downloaded, executed or installed; this is not a signature-verified self-updater.

## Tests and release

- Desktop tests use explicit run-owned profiles, WebView2 data, HOME/config, refs and local-only bare repositories. State preparation has no fallback to a user APPDATA file.
- Process cleanup validates PID plus creation time and run ancestry; system input/accessibility brokers are not application-owned merely because a window triggers them. Test probes and keys are temporary/build-only and never shipped.
- Installer tests refuse existing same-product installation/shortcuts/instances, record ownership, verify every notice/MPL archive hash, and uninstall only that test instance. User data and shared Git/WebView2 remain untouched.
- No telemetry, default networking, accounts, background sync or automatic publication. Unsigned builds retain their true Authenticode status; no SmartScreen reputation promise.
- Complete Win10/clean-VM/DPI/provider/PKI certification requires actual authorized environments and is not inferred from local simulations or passing unit tests.
