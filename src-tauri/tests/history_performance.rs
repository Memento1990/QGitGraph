//! History scan regressions against fast-imported, entirely temporary repositories.
//! These tests use real Git, isolated per-child configuration, no network, and no GUI.
//! Scan-window/process-work bounds are tested privately alongside history.rs.

use qgitgraph_lib::{
    git::GitService,
    model::{HistoryPage, HistoryQuery, Repository},
};
use serde_json::{json, Value};
use std::{
    fmt::Write as _,
    fs,
    io::Write as _,
    path::PathBuf,
    process::{Command, Stdio},
};
use tempfile::TempDir;

const REQUEST: &str = "history-performance";

struct Fixture {
    root: TempDir,
    home: PathBuf,
    path: PathBuf,
    service: GitService,
    repo: Repository,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("qgitgraph-history-performance-")
            .tempdir()
            .unwrap();
        let home = root.path().join("isolated home");
        let path = root.path().join("仓库 with spaces");
        for directory in [
            &home,
            &path,
            &root.path().join("templates"),
            &root.path().join("hooks"),
        ] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "history-performance-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "temporary history performance fixture".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            // History must discover real HEAD, not trust saved metadata.
            head: Some("0".repeat(40)),
            branch: Some("stale-branch".into()),
            trusted: true,
            bare: false,
        };
        let fixture = Self {
            root,
            home,
            path,
            service,
            repo,
        };
        fixture.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--template",
            fixture.root.path().join("templates").to_str().unwrap(),
        ]);
        for (key, value) in [
            ("user.name", "测试 Author"),
            ("user.email", "fixture@example.test"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.logAllRefUpdates", "true"),
            ("gc.auto", "0"),
        ] {
            fixture.git(&["config", "--local", key, value]);
        }
        fixture
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(self.service.git_path());
        command.current_dir(&self.path);
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        command
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join("xdg"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .env("GIT_PAGER", "cat")
            .env("GIT_EDITOR", "true")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args([
                "--no-pager",
                "-c",
                "color.ui=false",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "tag.gpgsign=false",
            ])
            .arg("-c")
            .arg(format!(
                "core.hooksPath={}",
                self.root.path().join("hooks").display()
            ))
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn git(&self, args: &[&str]) -> String {
        let output = self.command(args).output().unwrap();
        assert!(
            output.status.success(),
            "Git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn input(&self, args: &[&str], input: &[u8]) -> String {
        let mut command = self.command(args);
        command.stdin(Stdio::piped());
        let mut child = command.spawn().unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    /// Import a linear history in one process, with deliberately mixed metadata.
    /// The small fixture input is written only to this isolated child stdin.
    fn linear(&self, count: usize) -> Vec<String> {
        let mut input = String::new();
        for index in 0..count {
            let author = if index % 37 == 0 {
                "Needle Author"
            } else {
                "测试 Author"
            };
            let subject = if index % 113 == 0 {
                format!("Needle Subject {index}")
            } else {
                format!("commit {index}")
            };
            let body = if index % 97 == 0 {
                "Needle Body\n"
            } else {
                "ordinary body\n"
            };
            let message = format!("{subject}\n\n{body}");
            Self::import_commit(
                &mut input,
                "refs/heads/main",
                index + 1,
                author,
                1_704_067_200 + index,
                &message,
                if index == 0 { None } else { Some(index) },
            );
        }
        input.push_str("done\n");
        self.input(&["fast-import", "--quiet", "--done"], input.as_bytes());
        self.git(&["log", "--reverse", "--format=%H", "HEAD"])
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn import_commit(
        input: &mut String,
        reference: &str,
        mark: usize,
        author: &str,
        date: usize,
        message: &str,
        parent: Option<usize>,
    ) {
        writeln!(input, "commit {reference}\nmark :{mark}").unwrap();
        writeln!(input, "author {author} <fixture@example.test> {date} +0000").unwrap();
        writeln!(
            input,
            "committer Fixture <fixture@example.test> {date} +0000"
        )
        .unwrap();
        writeln!(input, "data {}", message.len()).unwrap();
        input.push_str(message);
        input.push('\n');
        if let Some(parent) = parent {
            writeln!(input, "from :{parent}").unwrap();
        }
        input.push('\n');
    }

    fn query(&self, overrides: Value) -> HistoryQuery {
        let mut value = json!({
            "repoId": self.repo.id, "requestId": REQUEST, "offset": 0, "limit": 17,
            "scope": {"kind": "head"}, "order": "topo", "mailmap": false,
            "showRemotes": true, "showTags": true, "showStashes": true,
            "includeReflog": false, "collapseStashAuxiliary": false
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(overrides.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    async fn history(&self, overrides: Value) -> HistoryPage {
        self.service
            .history(&self.repo, self.query(overrides))
            .await
            .unwrap()
    }

    fn expected_ids(&self, args: &[&str]) -> Vec<String> {
        self.git(args).lines().map(str::to_owned).collect()
    }
}

fn page_ids(page: &HistoryPage) -> Vec<String> {
    page.commits
        .iter()
        .map(|commit| commit.oid.clone())
        .collect()
}

fn assert_page(page: &HistoryPage, expected: &[String], offset: usize, limit: usize) {
    assert_eq!(
        page_ids(page),
        expected
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
    );
    assert_eq!(page.has_more, expected.len() > offset + limit);
}

#[tokio::test]
async fn manual_search_pages_match_independent_cli_filters_across_wide_windows() {
    let f = Fixture::new();
    let imported = f.linear(10_000);
    assert_eq!(imported.len(), 10_000);
    let _request = f.service.begin_request(REQUEST).unwrap();

    // Expected all-mode records are filtered independently from Git's complete
    // raw metadata; no production selection/parser helper is used as an oracle.
    let raw = f.git(&[
        "log",
        "--topo-order",
        "--format=%H%x1f%an%x1f%ae%x1f%s%x1f%b%x1e",
        "HEAD",
    ]);
    let all_expected: Vec<_> = raw
        .split('\u{1e}')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            (!record.is_empty() && record.to_lowercase().contains("needle"))
                .then(|| record.split('\u{1f}').next().unwrap().to_owned())
        })
        .collect();
    for offset in [0, 40, 200, all_expected.len().saturating_sub(2)] {
        let page = f
            .history(json!({"searchMode": "all", "search": "NeEdLe", "offset": offset}))
            .await;
        assert_page(&page, &all_expected, offset, 17);
    }

    // Interior substring matching, not prefix-only/rev-parse equivalence. An old
    // full OID forces scanning past the first two widened windows.
    let needle = &imported[13][11..18];
    let hash_expected: Vec<_> = imported
        .iter()
        .rev()
        .filter(|oid| oid.contains(needle))
        .cloned()
        .collect();
    let hash = f
        .history(json!({"searchMode": "hash", "search": needle}))
        .await;
    assert_page(&hash, &hash_expected, 0, 17);
    let old = f
        .history(json!({"searchMode": "hash", "search": imported[13]}))
        .await;
    assert_eq!(page_ids(&old), vec![imported[13].clone()]);
    assert!(!old.has_more);
    let absent = f
        .history(json!({"searchMode": "hash", "search": "not-a-hex-substring"}))
        .await;
    assert!(absent.commits.is_empty() && !absent.has_more);

    // Native filters and native skip/count must remain untouched.
    for (mode, flag) in [("author", "--author=Needle"), ("message", "--grep=Needle")] {
        let expected = f.expected_ids(&[
            "log",
            "--topo-order",
            "--fixed-strings",
            "--regexp-ignore-case",
            flag,
            "--format=%H",
            "HEAD",
        ]);
        let page = f
            .history(json!({"searchMode": mode, "search": "Needle", "offset": 19}))
            .await;
        assert_page(&page, &expected, 19, 17);
    }
    let date_expected = f.expected_ids(&[
        "log",
        "--topo-order",
        "--since-as-filter=@1704067200",
        "--until=@1704153599",
        "--format=%H",
        "HEAD",
    ]);
    let date = f
        .history(json!({"searchMode": "date", "search": "2024-01-01", "offset": 23}))
        .await;
    assert_page(&date, &date_expected, 23, 17);
    for order in ["topo", "date", "author-date"] {
        let expected: Vec<_> = imported.iter().rev().cloned().collect();
        let page = f
            .history(json!({"order": order, "offset": 503, "limit": 29}))
            .await;
        assert_page(&page, &expected, 503, 29);
    }
}

#[tokio::test]
async fn ref_search_intersects_scope_and_globs_preserve_129_tip_order() {
    let f = Fixture::new();
    let imported = f.linear(1_000);
    let root = &imported[0];
    let mut input = String::new();
    for index in 0..130 {
        let reference = format!("refs/heads/selected/{index:03}");
        // Use the existing immutable root OID in fast-import after the commit
        // header to keep 130 siblings distinct without 130 Git invocations.
        writeln!(
            input,
            "commit {reference}\ncommitter Fixture <fixture@example.test> {} +0000\ndata {}",
            1_704_080_000 + index,
            format!("tip {index}\n").len()
        )
        .unwrap();
        writeln!(input, "tip {index}\nfrom {root}\n").unwrap();
    }
    input.push_str("done\n");
    f.input(&["fast-import", "--quiet", "--done"], input.as_bytes());
    let outside = f
        .git(&["rev-parse", "refs/heads/selected/129"])
        .trim()
        .to_owned();
    let mut updates = String::new();
    let mut selected = Vec::new();
    for (index, oid) in [(0, &imported[850]), (1, &imported[20]), (2, &outside)] {
        writeln!(updates, "update refs/tags/needle/{index} {oid}").unwrap();
        selected.push(oid.clone());
    }
    f.input(&["update-ref", "--stdin"], updates.as_bytes());
    let _request = f.service.begin_request(REQUEST).unwrap();
    let refs_expected: Vec<_> = imported
        .iter()
        .rev()
        .filter(|oid| selected.contains(oid))
        .cloned()
        .collect();
    let refs = f
        .history(json!({"searchMode": "refs", "search": "needle/"}))
        .await;
    assert_page(&refs, &refs_expected, 0, 17);
    assert!(!page_ids(&refs).contains(&outside));

    // Obtain the independent oracle with explicit verified tip IDs on stdin,
    // preserving the same for-each-ref tip order used by history selection.
    let tips = f
        .git(&[
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            "refs/heads/selected/",
        ])
        .lines()
        .filter_map(|line| {
            let (oid, name) = line.split_once(' ')?;
            (name != "refs/heads/selected/129").then(|| oid.to_owned())
        })
        .collect::<Vec<_>>();
    assert_eq!(tips.len(), 129);
    let oracle = f.input(
        &["log", "--topo-order", "--format=%H", "--stdin", "--"],
        format!("{}\n", tips.join("\n")).as_bytes(),
    );
    let oracle: Vec<_> = oracle.lines().map(str::to_owned).collect();
    assert_eq!(oracle.len(), 130);
    let scope = json!({"kind": "glob", "include": ["refs/heads/selected/*"], "exclude": ["refs/heads/selected/129"]});
    let mut actual = Vec::new();
    for offset in (0..oracle.len()).step_by(17) {
        let page = f.history(json!({"scope": scope, "offset": offset})).await;
        assert_page(&page, &oracle, offset, 17);
        actual.extend(page_ids(&page));
    }
    assert_eq!(actual, oracle);
    let empty = f.history(json!({"scope": {"kind": "glob", "include": ["refs/heads/absent/*"]}, "includeReflog": true})).await;
    assert!(empty.commits.is_empty() && !empty.has_more);
}

#[tokio::test]
async fn stash_collapse_preserves_protected_auxiliary_roots_and_pagination() {
    let f = Fixture::new();
    let imported = f.linear(1_000);
    let mut input = String::new();
    // Root index/untracked auxiliaries ensure hiding a projection cannot prune
    // unrelated ancestry; an ordinary ref deliberately protects the index.
    Fixture::import_commit(
        &mut input,
        "refs/heads/keep-index",
        1,
        "Fixture",
        1_704_090_001,
        "index auxiliary\n",
        None,
    );
    Fixture::import_commit(
        &mut input,
        "refs/fixture/untracked",
        2,
        "Fixture",
        1_704_090_002,
        "untracked auxiliary\n",
        None,
    );
    // The stash has a main base plus the two auxiliary parents.
    writeln!(input, "commit refs/stash\nmark :3\ncommitter Fixture <fixture@example.test> 1704090003 +0000\ndata 14\nstash subject\n\nfrom {}\nmerge :1\nmerge :2\n\ndone", imported.last().unwrap()).unwrap();
    f.input(&["fast-import", "--quiet", "--done"], input.as_bytes());
    let index = f
        .git(&["rev-parse", "refs/heads/keep-index"])
        .trim()
        .to_owned();
    let untracked = f
        .git(&["rev-parse", "refs/fixture/untracked"])
        .trim()
        .to_owned();
    f.git(&["update-ref", "-d", "refs/fixture/untracked"]);
    let stash = f.git(&["rev-parse", "refs/stash"]).trim().to_owned();
    // Stash graph decorations come from its reflog, not just the bare ref.
    f.git(&["update-ref", "-d", "refs/stash"]);
    f.git(&[
        "update-ref",
        "--create-reflog",
        "-m",
        "fixture stash",
        "refs/stash",
        &stash,
    ]);
    let expected = f.expected_ids(&[
        "log",
        "--topo-order",
        "--format=%H",
        "HEAD",
        "refs/stash",
        "refs/heads/keep-index",
    ]);
    let collapsed_expected: Vec<_> = expected
        .into_iter()
        .filter(|oid| oid != &untracked)
        .collect();
    let _request = f.service.begin_request(REQUEST).unwrap();
    let options = json!({"scope": {"kind": "all"}, "collapseStashAuxiliary": true, "limit": 1000});
    let first = f.history(options).await;
    assert_page(&first, &collapsed_expected, 0, 1000);
    assert!(page_ids(&first).contains(&index));
    let node = first
        .commits
        .iter()
        .find(|commit| commit.oid == stash)
        .unwrap();
    assert_eq!(node.parents.len(), 3);
    assert_eq!(node.node_kind.as_deref(), Some("stash"));
    assert_eq!(
        node.graph_parents.as_ref().unwrap(),
        &vec![imported.last().unwrap().clone(), index]
    );
    let tail = f.history(json!({"scope": {"kind": "all"}, "collapseStashAuxiliary": true, "limit": 17, "offset": 990})).await;
    assert_page(&tail, &collapsed_expected, 990, 17);
    f.git(&["update-ref", "-d", "refs/heads/keep-index"]);
    let unprotected = f
        .history(json!({"scope": {"kind": "all"}, "collapseStashAuxiliary": true, "limit": 10}))
        .await;
    let node = unprotected
        .commits
        .iter()
        .find(|commit| commit.oid == stash)
        .unwrap();
    assert_eq!(
        node.graph_parents.as_ref().unwrap(),
        &vec![imported.last().unwrap().clone()]
    );
}

#[tokio::test]
async fn scan_cap_is_truthful_but_early_pages_and_native_paging_still_work() {
    let f = Fixture::new();
    let imported = f.linear(100_001);
    let _request = f.service.begin_request(REQUEST).unwrap();
    let early = f
        .history(json!({"searchMode": "all", "search": "commit", "limit": 1}))
        .await;
    assert_eq!(early.commits.len(), 1);
    assert!(early.has_more);
    let native = f.history(json!({"offset": 100_000, "limit": 1})).await;
    assert_eq!(page_ids(&native), vec![imported[0].clone()]);
    assert!(!native.has_more);
    let error = f
        .service
        .history(
            &f.repo,
            f.query(json!({"searchMode": "hash", "search": imported[0]})),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "SEARCH_LIMIT");
    let error = f
        .service
        .history(
            &f.repo,
            f.query(json!({"searchMode": "all", "search": "does-not-exist"})),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "SEARCH_LIMIT");
    // Exact-cap, full-final-window behavior is intentionally unchanged: without
    // a sentinel proving EOF, the API must not silently claim no more matches.
    f.git(&["update-ref", "refs/heads/main", &imported[99_999]]);
    let error = f
        .service
        .history(
            &f.repo,
            f.query(json!({"searchMode": "hash", "search": "absent"})),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "SEARCH_LIMIT");
}

#[tokio::test]
async fn wider_batches_retry_small_without_losing_early_matches_on_output_limit() {
    let f = Fixture::new();
    // Newest 500 rows are small and have no matches. The following 1000 rows
    // carry 36 KiB bodies: each old 500-row response fits the 32 MiB cap, but the
    // widened second response does not. Stream fixture input, not a giant buffer.
    let body = "x".repeat(36 * 1024);
    let mut command = f.command(&["fast-import", "--quiet", "--done"]);
    command.stdin(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for index in 0..1_500 {
        let message = if index < 1_000 {
            format!("Needle Body row {index}\n\n{body}\n")
        } else {
            format!("ordinary row {index}\n")
        };
        let mut record = String::new();
        Fixture::import_commit(
            &mut record,
            "refs/heads/main",
            index + 1,
            "Fixture",
            1_705_000_000 + index,
            &message,
            if index == 0 { None } else { Some(index) },
        );
        stdin.write_all(record.as_bytes()).unwrap();
    }
    stdin.write_all(b"done\n").unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _request = f.service.begin_request(REQUEST).unwrap();
    let page = f
        .history(json!({
            "searchMode": "all", "search": "Needle Body row", "limit": 1
        }))
        .await;
    assert_eq!(page.commits.len(), 1);
    assert!(page.has_more);
    assert_eq!(page.commits[0].subject, "Needle Body row 999");
}

#[tokio::test]
async fn cancelled_queries_do_not_return_false_empty_successes() {
    let f = Fixture::new();
    f.linear(1_000);
    let _request = f.service.begin_request(REQUEST).unwrap();
    f.service.cancel(REQUEST);
    let error = f
        .service
        .history(
            &f.repo,
            f.query(json!({"scope": {"kind": "refs", "refs": []}})),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    assert!(f.service.active_process(REQUEST).is_none());
}

#[tokio::test]
async fn head_marking_and_ref_search_refresh_after_external_updates() {
    let f = Fixture::new();
    let imported = f.linear(1_000);
    f.git(&["update-ref", "refs/tags/needle", &imported[100]]);
    let _request = f.service.begin_request(REQUEST).unwrap();
    let first = f
        .history(json!({"markHeadAncestry": true, "searchMode": "refs", "search": "needle"}))
        .await;
    assert_eq!(page_ids(&first), vec![imported[100].clone()]);
    assert_eq!(first.commits[0].in_head, Some(true));
    f.git(&["update-ref", "refs/heads/main", &imported[500]]);
    f.git(&["update-ref", "refs/tags/needle", &imported[900]]);
    let changed = f.history(json!({"scope": {"kind": "all"}, "markHeadAncestry": true, "searchMode": "refs", "search": "needle"})).await;
    assert_eq!(page_ids(&changed), vec![imported[900].clone()]);
    assert_eq!(changed.commits[0].in_head, Some(false));
    assert_eq!(first.commits[0].refs[0].full_name, "refs/tags/needle");
    let scope = f
        .history(json!({"scope": {"kind": "head"}, "searchMode": "refs", "search": "needle"}))
        .await;
    assert!(scope.commits.is_empty() && !scope.has_more);
}
