//! Read-path regression tests and real Git launch counts. Every repository,
//! trace file, identity and config lives under a new TempDir; no user Git state
//! or global environment is changed. Trace2 is enabled only in that fixture's
//! isolated global config, never in a real repository or product configuration.

use qgitgraph_lib::{
    git::GitService,
    model::{ComparisonQuery, DiffQuery, Repository},
};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
use tempfile::TempDir;

const FILE: &str = "tracked 中文[1].txt";
const CONTENT_LIMIT: usize = 2 * 1024 * 1024;
const PATCH_LIMIT: usize = 4 * 1024 * 1024;

struct Fixture {
    root: TempDir,
    home: PathBuf,
    path: PathBuf,
    trace: PathBuf,
    service: GitService,
    repo: Repository,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("qgitgraph-read-performance-")
            .tempdir()
            .unwrap();
        let home = root.path().join("isolated home");
        let path = root.path().join("repo 中文");
        let trace = root.path().join("git trace.jsonl");
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
            id: "read-performance-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "isolated read fixture".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: false,
            bare: false,
        };
        let fixture = Self {
            root,
            home,
            path,
            trace,
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
            ("user.name", "Read Fixture"),
            ("user.email", "read@example.invalid"),
            ("core.autocrlf", "false"),
            ("core.safecrlf", "false"),
            ("core.filemode", "false"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
        ] {
            fixture.git(&["config", "--local", key, value]);
        }
        fixture.git(&[
            "config",
            "--file",
            fixture.home.join(".gitconfig").to_str().unwrap(),
            "trace2.eventTarget",
            fixture.trace.to_str().unwrap(),
        ]);
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
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_AUTHOR_DATE", "@1704067200 +0000")
            .env("GIT_COMMITTER_DATE", "@1704067200 +0000")
            .args([
                "--no-pager",
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
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    fn input(&self, args: &[&str], input: &[u8]) -> String {
        let mut child = self.command(args).stdin(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    fn write(&self, path: &str, bytes: &[u8]) {
        let target = self.path.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
    }

    fn commit(&self, message: &str) -> String {
        self.git(&["add", "--all", "--", "."]);
        self.git(&["commit", "--quiet", "--no-gpg-sign", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }

    fn query(&self, id: &str, base: Option<&str>, target: &str, path: &str) -> DiffQuery {
        DiffQuery {
            repo_id: self.repo.id.clone(),
            request_id: id.into(),
            base: base.map(str::to_owned),
            target: target.into(),
            path: path.into(),
            old_path: None,
            context: Some(3),
            encoding: None,
            staged: None,
        }
    }

    fn clear_trace(&self) {
        fs::write(&self.trace, b"").unwrap();
    }

    fn launches(&self) -> Vec<Vec<String>> {
        fs::read_to_string(&self.trace)
            .unwrap()
            .lines()
            .filter_map(|line| {
                let event: Value = serde_json::from_str(line).unwrap();
                if event["event"] != "start" || event["sid"].as_str().unwrap().contains('/') {
                    return None;
                }
                Some(
                    event["argv"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|arg| arg.as_str().unwrap().to_owned())
                        .collect(),
                )
            })
            .collect()
    }

    fn assert_launches(&self, expected: &[&str]) {
        let launches = self.launches();
        assert_eq!(
            launches.len(),
            expected.len(),
            "Git launches: {launches:#?}"
        );
        for verb in expected {
            let actual = launches
                .iter()
                .filter(|args| args.iter().any(|arg| arg == verb))
                .count();
            let count = expected.iter().filter(|value| *value == verb).count();
            assert_eq!(actual, count, "Expected {verb}: {launches:#?}");
        }
    }

    fn remove_loose_object(&self, oid: &str) {
        fs::remove_file(
            self.path
                .join(".git/objects")
                .join(&oid[..2])
                .join(&oid[2..]),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn historical_patch_is_three_launches_and_each_lazy_side_reads_only_one_blob() {
    let f = Fixture::new();
    f.write(FILE, b"base\n");
    let root = f.commit("root");
    f.write(FILE, b"tip\n");
    let tip = f.commit("tip");
    let q = f.query("read-patch", Some(&root), &tip, FILE);
    f.clear_trace();
    let patch = f.service.diff_patch(&f.repo, q.clone()).await.unwrap();
    assert!(patch.patch.contains("-base\n+tip\n"));
    assert!(!patch.binary && !patch.truncated);
    assert!(patch.old_content.is_none() && patch.new_content.is_none());
    f.assert_launches(&["rev-parse", "rev-parse", "diff"]);
    for (side, expected) in [("old", "base\n"), ("new", "tip\n")] {
        f.clear_trace();
        let content = f
            .service
            .content_side(&f.repo, q.clone(), side)
            .await
            .unwrap();
        assert!(content.patch.is_empty() && !content.binary && !content.truncated);
        if side == "old" {
            assert_eq!(content.old_content.as_deref(), Some(expected));
            assert!(content.new_content.is_none());
        } else {
            assert_eq!(content.new_content.as_deref(), Some(expected));
            assert!(content.old_content.is_none());
        }
        f.assert_launches(&["rev-parse", "rev-parse", "ls-tree", "cat-file"]);
        assert!(f
            .launches()
            .iter()
            .find(|args| args.iter().any(|arg| arg == "cat-file"))
            .unwrap()
            .iter()
            .any(|arg| arg == "--batch"));
    }
    f.clear_trace();
    let legacy = f.service.diff(&f.repo, q).await.unwrap();
    assert_eq!(legacy.patch, patch.patch);
    assert_eq!(legacy.old_content.as_deref(), Some("base\n"));
    assert_eq!(legacy.new_content.as_deref(), Some("tip\n"));
    f.assert_launches(&[
        "rev-parse",
        "rev-parse",
        "ls-tree",
        "ls-tree",
        "cat-file",
        "diff",
    ]);
    f.write(
        FILE,
        b"Binary files and GIT binary patch are ordinary text\n",
    );
    let text_tip = f.commit("binary marker text");
    let text = f
        .service
        .diff_patch(
            &f.repo,
            f.query("read-binary-text", Some(&tip), &text_tip, FILE),
        )
        .await
        .unwrap();
    assert!(!text.binary);
}

#[tokio::test]
async fn lazy_new_side_does_not_read_missing_old_blob_and_resolution_never_stales() {
    let f = Fixture::new();
    f.write(FILE, b"old blob\n");
    let root = f.commit("root");
    let old_blob = f.git(&["rev-parse", &format!("{root}:{FILE}")]);
    f.write(FILE, b"new blob\n");
    let tip = f.commit("tip");
    f.remove_loose_object(&old_blob);
    let q = f.query("read-one-side", Some(&root), &tip, FILE);
    f.clear_trace();
    let content = f
        .service
        .content_side(&f.repo, q.clone(), "new")
        .await
        .unwrap();
    assert_eq!(content.new_content.as_deref(), Some("new blob\n"));
    assert!(content.old_content.is_none());
    f.assert_launches(&["rev-parse", "rev-parse", "ls-tree", "cat-file"]);
    assert!(f.service.content_side(&f.repo, q, "old").await.is_err());
    assert_eq!(
        f.service
            .resolve_revision(&f.repo, "read-resolve", &tip)
            .await
            .unwrap(),
        tip
    );
    f.remove_loose_object(&tip);
    assert!(f
        .service
        .resolve_revision(&f.repo, "read-resolve", &tip)
        .await
        .is_err());
}

#[tokio::test]
async fn fast_detail_is_four_launches_including_root_and_keeps_legacy_decorations() {
    let f = Fixture::new();
    f.write(FILE, b"root\n");
    let root = f.commit("root");
    f.write(FILE, b"child\n");
    let child = f.commit("child");
    for (oid, parent, diff_verb) in [
        (&root, Some("ROOT"), "diff-tree"),
        (&child, Some(root.as_str()), "diff"),
    ] {
        f.clear_trace();
        let detail = f
            .service
            .commit_detail_fast_with_mailmap(&f.repo, oid, "read-fast-detail", parent, false)
            .await
            .unwrap();
        assert_eq!(&detail.commit.oid, oid);
        assert!(detail.commit.refs.is_empty());
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.signature.status, "N");
        f.assert_launches(&["rev-parse", "log", diff_verb, "cat-file"]);
    }
    let legacy = f
        .service
        .commit_detail(&f.repo, &child, "read-legacy-detail", None)
        .await
        .unwrap();
    assert!(legacy
        .commit
        .refs
        .iter()
        .any(|item| item.full_name == "refs/heads/main"));
    f.clear_trace();
    assert_eq!(
        f.service
            .commit_detail_fast_with_mailmap(
                &f.repo,
                &root,
                "read-invalid-parent",
                Some(&child),
                true
            )
            .await
            .unwrap_err()
            .code,
        "ARGUMENT"
    );
    f.assert_launches(&["rev-parse", "log"]);
    let from_empty = f
        .service
        .compare(
            &f.repo,
            ComparisonQuery {
                repo_id: f.repo.id.clone(),
                request_id: "read-root-compare".into(),
                base: Some("ROOT".into()),
                target: child,
            },
        )
        .await
        .unwrap();
    assert_eq!(from_empty[0].status, "A");
    assert_eq!(from_empty[0].additions, Some(1));
    assert_eq!(from_empty[0].deletions, Some(0));
}

#[tokio::test]
async fn fast_detail_signature_presence_never_executes_a_verifier() {
    let f = Fixture::new();
    f.write(FILE, b"root\n");
    let root = f.commit("root");
    let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
    let raw = format!("tree {tree}\nparent {root}\nauthor Test <read@example.invalid> 1704067200 +0000\ncommitter Test <read@example.invalid> 1704067200 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n not-a-valid-signature\n -----END PGP SIGNATURE-----\n\nsigned fixture\n\nbody\n");
    let signed = f.input(
        &["hash-object", "-t", "commit", "-w", "--stdin"],
        raw.as_bytes(),
    );
    f.git(&[
        "config",
        "--local",
        "gpg.program",
        f.root
            .path()
            .join("must-not-execute-verifier")
            .to_str()
            .unwrap(),
    ]);
    f.git(&["config", "--local", "log.showSignature", "true"]);
    f.clear_trace();
    let detail = f
        .service
        .commit_detail_fast_with_mailmap(&f.repo, &signed, "read-signed", None, true)
        .await
        .unwrap();
    assert_eq!(detail.signature.status, "U");
    assert!(detail.signature.signer.is_empty() && detail.signature.key.is_empty());
    assert!(detail.body.contains("body"));
    f.assert_launches(&["rev-parse", "log", "diff", "cat-file"]);
    assert!(!f.launches().iter().flatten().any(|arg| arg.contains("%G")));
}

#[tokio::test]
async fn binary_rename_and_literal_text_rename_have_truthful_patch_and_lazy_sides() {
    let f = Fixture::new();
    f.write(FILE, b"one\ntwo\nthree\n");
    f.write("binary.bin", b"one\0two\xff");
    let root = f.commit("root");
    f.git(&["mv", "--", FILE, "renamed 中文[2].txt"]);
    f.git(&["mv", "--", "binary.bin", "renamed binary.bin"]);
    let tip = f.commit("renames");
    for (new, old, binary) in [
        ("renamed 中文[2].txt", FILE, false),
        ("renamed binary.bin", "binary.bin", true),
    ] {
        let mut q = f.query("read-rename", Some(&root), &tip, new);
        q.old_path = Some(old.into());
        f.clear_trace();
        let patch = f.service.diff_patch(&f.repo, q.clone()).await.unwrap();
        assert!(patch.patch.contains("rename from ") && patch.patch.contains("rename to "));
        assert_eq!(patch.binary, binary);
        assert!(patch.old_content.is_none() && patch.new_content.is_none());
        f.assert_launches(&["rev-parse", "rev-parse", "diff"]);
        for side in ["old", "new"] {
            let content = f
                .service
                .content_side(&f.repo, q.clone(), side)
                .await
                .unwrap();
            assert_eq!(content.binary, binary);
            if binary {
                assert!(content.old_content.is_none() && content.new_content.is_none());
            } else {
                assert_eq!(
                    content
                        .old_content
                        .as_deref()
                        .or(content.new_content.as_deref()),
                    Some("one\ntwo\nthree\n")
                );
            }
        }
    }
}

#[tokio::test]
async fn patch_preview_is_independent_of_legacy_content_limit_and_capped_at_four_mib() {
    let f = Fixture::new();
    f.write(FILE, b"root\n");
    let root = f.commit("root");
    let mut large = vec![b'x'; CONTENT_LIMIT + 1];
    large.push(b'\n');
    f.write("large.txt", &large);
    let middle = f.commit("large text");
    large[0] = b'y';
    f.write("large.txt", &large);
    let tip = f.commit("small change to large content");
    let q = f.query("read-large", Some(&middle), &tip, "large.txt");
    f.clear_trace();
    let patch = f.service.diff_patch(&f.repo, q.clone()).await.unwrap();
    assert!(patch.truncated && !patch.binary);
    assert_eq!(patch.patch.len(), PATCH_LIMIT);
    assert!(patch.old_content.is_none() && patch.new_content.is_none());
    f.assert_launches(&["rev-parse", "rev-parse", "diff"]);
    f.clear_trace();
    let lazy = f
        .service
        .content_side(&f.repo, q.clone(), "new")
        .await
        .unwrap();
    assert!(lazy.truncated && lazy.new_content.is_none());
    f.assert_launches(&["rev-parse", "rev-parse", "ls-tree"]);
    let legacy = f.service.diff(&f.repo, q).await.unwrap();
    assert!(legacy.truncated && legacy.patch.is_empty());
    assert!(legacy.old_content.is_none() && legacy.new_content.is_none());
    let add = f
        .service
        .diff_patch(
            &f.repo,
            f.query("read-large-add", Some(&root), &middle, "large.txt"),
        )
        .await
        .unwrap();
    assert!(!add.truncated && !add.binary && !add.patch.is_empty());
    assert!(add.new_content.is_none());
}

#[tokio::test]
async fn worktree_index_root_and_untracked_previews_preserve_read_only_contract() {
    let f = Fixture::new();
    f.write(FILE, b"base\n");
    f.commit("root");
    f.write(FILE, b"staged\n");
    f.git(&["add", "--", FILE]);
    f.write(FILE, b"unstaged\n");
    f.write("untracked 中文.txt", b"one\ntwo");
    f.write("empty.txt", b"");
    f.write("binary.bin", b"\0binary");
    for (base, target, old, new) in [
        (Some("HEAD"), "INDEX", "base\n", "staged\n"),
        (Some("INDEX"), "WORKTREE", "staged\n", "unstaged\n"),
        (Some("HEAD"), "WORKTREE", "base\n", "unstaged\n"),
    ] {
        let q = f.query("read-working", base, target, FILE);
        let patch = f.service.diff_patch(&f.repo, q.clone()).await.unwrap();
        assert!(patch.patch.contains(&format!("-{}+{}", old, new)));
        assert_eq!(
            f.service
                .content_side(&f.repo, q.clone(), "old")
                .await
                .unwrap()
                .old_content
                .as_deref(),
            Some(old)
        );
        assert_eq!(
            f.service
                .content_side(&f.repo, q, "new")
                .await
                .unwrap()
                .new_content
                .as_deref(),
            Some(new)
        );
    }
    let mut staged = f.query("read-staged-override", None, "WORKTREE", FILE);
    staged.staged = Some(true);
    assert_eq!(
        f.service
            .content_side(&f.repo, staged, "new")
            .await
            .unwrap()
            .new_content
            .as_deref(),
        Some("staged\n")
    );
    for (path, binary) in [
        ("untracked 中文.txt", false),
        ("empty.txt", false),
        ("binary.bin", true),
    ] {
        let patch = f
            .service
            .diff_patch(
                &f.repo,
                f.query("read-untracked", Some("HEAD"), "WORKTREE", path),
            )
            .await
            .unwrap();
        assert!(patch.patch.contains("new file mode"));
        assert_eq!(patch.binary, binary);
        assert!(!patch.truncated);
        assert!(patch.old_content.is_none() && patch.new_content.is_none());
        if path.starts_with("untracked") {
            assert!(patch
                .patch
                .contains("+one\n+two\n\\ No newline at end of file"));
        }
    }
    f.clear_trace();
    let unchanged = f
        .service
        .diff_patch(
            &f.repo,
            f.query("read-no-content", Some("INDEX"), "WORKTREE", "missing.txt"),
        )
        .await
        .unwrap();
    assert!(unchanged.patch.is_empty() && !unchanged.binary && !unchanged.truncated);
    f.assert_launches(&["config", "ls-files", "diff", "ls-files"]);
    let unborn = Fixture::new();
    unborn.write(FILE, b"new\n");
    let patch = unborn
        .service
        .diff_patch(
            &unborn.repo,
            unborn.query("read-unborn", None, "WORKTREE", FILE),
        )
        .await
        .unwrap();
    assert!(patch.patch.contains("+new\n"));
    let old = unborn
        .service
        .content_side(
            &unborn.repo,
            unborn.query("read-unborn-side", None, "WORKTREE", FILE),
            "old",
        )
        .await
        .unwrap();
    assert!(old.old_content.is_none() && old.new_content.is_none());
}

#[tokio::test]
async fn snapshot_reads_one_stash_list_and_reuses_complete_stash_metadata() {
    let f = Fixture::new();
    f.write(FILE, b"base\n");
    f.commit("root");
    f.write(FILE, b"stashed\n");
    f.git(&["stash", "push", "--quiet", "-m", "snapshot fixture"]);
    f.clear_trace();
    // Deliberately no caller RequestGuard: the public snapshot owns its joined
    // children's scope until all complete, also for non-command API consumers.
    let snapshot = f.service.snapshot(&f.repo, "read-snapshot").await.unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    let stash = &snapshot.stashes[0];
    assert!(stash.timestamp > 0 && stash.message.contains("snapshot fixture"));
    assert!(snapshot
        .refs
        .iter()
        .any(|item| item.full_name == stash.selector && item.oid == stash.oid));
    // 两次 index token 前后夹住快照；另枚举 gitlink 防止 status 隐式递归子仓过滤器。
    f.assert_launches(&[
        "ls-files",
        "hash-object",
        "for-each-ref",
        "stash",
        "status",
        "config",
        "config",
        "ls-files",
        "ls-files",
        "hash-object",
    ]);
    let filter_checks = f
        .launches()
        .into_iter()
        .filter(|args| {
            args.windows(5).any(|part| {
                part == [
                    "config",
                    "--null",
                    "--includes",
                    "--get-regexp",
                    "^filter\\..*\\.(clean|smudge|process|required)$",
                ]
            })
        })
        .count();
    assert_eq!(
        filter_checks, 1,
        "Untrusted status requires exactly one filter safety preflight."
    );
    f.clear_trace();
    let (refs, stashes) = f
        .service
        .reference_state(&f.repo, "read-references")
        .await
        .unwrap();
    assert_eq!(stashes[0].timestamp, stash.timestamp);
    assert!(refs.iter().any(|item| item.full_name == stash.selector));
    f.assert_launches(&["for-each-ref", "stash"]);
}

#[tokio::test]
async fn encoding_validation_and_named_side_reject_unsafe_queries_before_content_reads() {
    let f = Fixture::new();
    f.write(FILE, b"base\n");
    let root = f.commit("root");
    f.write("encoded.txt", &[0xd6, 0xd0, 0xce, 0xc4, b'\n']);
    f.write("wide.txt", &[0xff, 0xfe, b'A', 0, b'\n', 0]);
    let tip = f.commit("encodings");
    let mut gbk = f.query("read-encoding", Some(&root), &tip, "encoded.txt");
    gbk.encoding = Some("gbk".into());
    let decoded = f
        .service
        .content_side(&f.repo, gbk.clone(), "new")
        .await
        .unwrap();
    assert_eq!(decoded.new_content.as_deref(), Some("中文\n"));
    assert!(!decoded.binary);
    assert!(f
        .service
        .diff_patch(&f.repo, gbk,)
        .await
        .unwrap()
        .patch
        .contains("+中文\n"));
    let wide = f
        .service
        .content_side(
            &f.repo,
            f.query("read-wide", Some(&root), &tip, "wide.txt"),
            "new",
        )
        .await
        .unwrap();
    assert_eq!(wide.new_content.as_deref(), Some("A\n"));
    assert!(!wide.binary);
    for (path, old_path, context, encoding, side) in [
        ("../outside", None, None, None, "new"),
        (FILE, Some(".git/config"), None, None, "old"),
        (FILE, None, Some(10001), None, "new"),
        (FILE, None, None, Some("not-an-encoding"), "new"),
        (FILE, None, None, None, "both"),
    ] {
        let mut q = f.query("read-invalid", Some(&root), &tip, path);
        q.old_path = old_path.map(str::to_owned);
        q.context = context;
        q.encoding = encoding.map(str::to_owned);
        f.clear_trace();
        assert_eq!(
            f.service
                .content_side(&f.repo, q, side)
                .await
                .unwrap_err()
                .code,
            "ARGUMENT"
        );
        assert!(f.launches().is_empty());
    }
}

#[tokio::test]
async fn quiet_optional_head_preserves_missing_object_and_unborn_errors() {
    let f = Fixture::new();
    f.write(FILE, b"base\n");
    let head = f.commit("root");
    f.clear_trace();
    let patch = f
        .service
        .diff_patch(
            &f.repo,
            f.query("read-normal-head", Some("HEAD"), "WORKTREE", FILE),
        )
        .await
        .unwrap();
    assert!(patch.patch.is_empty());
    f.assert_launches(&["rev-parse", "config", "ls-files", "diff", "ls-files"]);
    f.remove_loose_object(&head);
    assert!(f
        .service
        .diff_patch(&f.repo, f.query("read-broken-head", None, "WORKTREE", FILE))
        .await
        .is_err());
}

#[tokio::test]
async fn pre_cancelled_lazy_reads_and_parallel_snapshots_never_spawn_git() {
    let f = Fixture::new();
    f.write(FILE, b"base\n");
    let head = f.commit("root");
    for (id, method) in [
        ("read-cancel-patch", "patch"),
        ("read-cancel-side", "side"),
        ("read-cancel-snapshot", "snapshot"),
    ] {
        f.service.cancel(id);
        f.clear_trace();
        let error = match method {
            "patch" => f
                .service
                .diff_patch(&f.repo, f.query(id, Some("ROOT"), &head, FILE))
                .await
                .unwrap_err(),
            "side" => f
                .service
                .content_side(&f.repo, f.query(id, Some("ROOT"), &head, FILE), "new")
                .await
                .unwrap_err(),
            _ => f.service.snapshot(&f.repo, id).await.unwrap_err(),
        };
        assert_eq!(error.code, "CANCELLED");
        assert!(f.launches().is_empty());
    }
}

#[cfg(not(windows))]
#[tokio::test]
async fn historical_patch_and_content_paths_are_nul_literal_with_tabs_and_newlines() {
    let f = Fixture::new();
    let path = "literal\tline\n中文[1].txt";
    f.write(path, b"before\n");
    let root = f.commit("root");
    f.write(path, b"after\n");
    let tip = f.commit("tip");
    let q = f.query("read-nul-literal", Some(&root), &tip, path);
    let patch = f.service.diff_patch(&f.repo, q.clone()).await.unwrap();
    assert!(patch.patch.contains("-before\n+after\n"));
    let content = f.service.content_side(&f.repo, q, "new").await.unwrap();
    assert_eq!(content.new_content.as_deref(), Some("after\n"));
}
