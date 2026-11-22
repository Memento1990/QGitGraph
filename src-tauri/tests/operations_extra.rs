//! Focused real-Git coverage for noninteractive history rewrites.
//! Every repository, configuration and hook directory lives in its own TempDir.

use qgitgraph_lib::{
    error::Result,
    git::GitService,
    model::{ActionResult, DiffQuery, GitAction, Repository},
};
use serde_json::json;
use std::{
    cell::Cell,
    fs,
    path::PathBuf,
    process::{Command, Stdio},
};
use tempfile::TempDir;

const REQUEST: &str = "operations-extra";

struct Fixture {
    _directory: TempDir,
    home: PathBuf,
    path: PathBuf,
    hooks: PathBuf,
    service: GitService,
    repo: Repository,
    clock: Cell<u64>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-operations-")
            .tempdir()
            .unwrap();
        let home = directory.path().join("隔离 Home");
        let path = directory.path().join("操作仓库 with 空格");
        let hooks = directory.path().join("empty hooks");
        let template = directory.path().join("empty template");
        for directory in [&home, &path, &hooks, &template] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "operations-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "操作仓库 with 空格".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: true,
            bare: false,
        };
        let fixture = Self {
            _directory: directory,
            home,
            path,
            hooks,
            service,
            repo,
            clock: Cell::new(1_704_067_200),
        };
        fixture.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--template",
            template.to_str().unwrap(),
        ]);
        for (key, value) in [
            ("user.name", "Operations 作者"),
            ("user.email", "operations@example.test"),
            ("core.autocrlf", "false"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.hooksPath", fixture.hooks.to_str().unwrap()),
        ] {
            fixture.git(&["config", "--local", key, value]);
        }
        fixture.write("base.txt", b"base content\n");
        fixture.commit("root");
        fixture
    }

    fn git_bytes(&self, args: &[&str]) -> Vec<u8> {
        let mut command = Command::new(self.service.git_path());
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        let date = format!("@{} +0000", self.clock.get());
        let output = command
            .current_dir(&self.path)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .env("GIT_PAGER", "cat")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "false")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .args([
                "--no-pager",
                "-c",
                "core.autocrlf=false",
                "-c",
                "commit.gpgsign=false",
            ])
            .arg("-c")
            .arg(format!("core.hooksPath={}", self.hooks.display()))
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture Git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn git(&self, args: &[&str]) -> String {
        String::from_utf8(self.git_bytes(args))
            .unwrap()
            .trim_end()
            .to_owned()
    }

    fn write(&self, path: &str, content: &[u8]) {
        fs::write(self.path.join(path), content).unwrap();
    }

    fn commit(&self, message: &str) -> String {
        self.git(&["add", "--all", "--", "."]);
        self.clock.set(self.clock.get() + 60);
        self.git(&["commit", "--quiet", "--no-gpg-sign", "--message", message]);
        self.git(&["rev-parse", "HEAD"])
    }

    async fn action(&self, kind: &str, target: &str) -> Result<ActionResult> {
        let action: GitAction = serde_json::from_value(json!({
            "repoId": self.repo.id,
            "requestId": REQUEST,
            "kind": kind,
            "target": target,
            "interactive": false,
            "sign": false
        }))
        .unwrap();
        let _transaction = self.service.transaction(&self.repo.id).await;
        self.service.action(&self.repo, action).await
    }
}

#[tokio::test]
async fn noninteractive_rebase_replays_commits_onto_new_base_and_keeps_branch_attached() {
    let fixture = Fixture::new();
    fixture.git(&["switch", "--quiet", "--create", "topic"]);
    fixture.write("topic one 中文.txt", b"first topic change\n");
    let old_first = fixture.commit("topic one");
    fixture.write("topic two.txt", b"second topic change\n");
    let old_tip = fixture.commit("topic two");
    fixture.git(&["switch", "--quiet", "main"]);
    fixture.write("upstream.txt", b"new upstream content\n");
    let upstream = fixture.commit("upstream change");
    fixture.git(&["switch", "--quiet", "topic"]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();

    let result = fixture.action("rebase", &upstream).await.unwrap();
    assert!(result.operation.is_none());
    assert_eq!(fixture.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
    assert_eq!(fixture.git(&["rev-parse", "refs/heads/main"]), upstream);
    let rewritten = fixture.git(&["rev-list", "--reverse", &format!("{upstream}..HEAD"), "--"]);
    let commits: Vec<_> = rewritten.lines().collect();
    assert_eq!(commits.len(), 2);
    assert_ne!(commits[0], old_first);
    assert_ne!(commits[1], old_tip);
    assert_eq!(
        fixture.git(&["rev-parse", &format!("{}^1", commits[0])]),
        upstream
    );
    assert_eq!(fixture.git(&["rev-parse", "HEAD^1"]), commits[0]);
    assert_eq!(
        fixture.git(&["log", "-2", "--format=%s"]),
        "topic two\ntopic one"
    );
    for (path, expected) in [
        ("base.txt", b"base content\n".as_slice()),
        ("upstream.txt", b"new upstream content\n".as_slice()),
        ("topic one 中文.txt", b"first topic change\n".as_slice()),
        ("topic two.txt", b"second topic change\n".as_slice()),
    ] {
        assert_eq!(fs::read(fixture.path.join(path)).unwrap(), expected);
    }
    let state = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert!(state.files.is_empty() && state.operation.is_none());
    assert_eq!(state.branch.as_deref(), Some("topic"));
}

#[tokio::test]
async fn drop_linear_commit_rewrites_only_descendants_and_removes_its_changes() {
    let fixture = Fixture::new();
    let root = fixture.git(&["rev-parse", "HEAD"]);
    fixture.write("drop this.txt", b"only the dropped commit adds this\n");
    let dropped = fixture.commit("remove this commit");
    fixture.write("keep first 中文.txt", b"first retained change\n");
    let old_first = fixture.commit("keep first");
    fixture.write("keep second.txt", b"second retained change\n");
    let old_tip = fixture.commit("keep second");
    let _request = fixture.service.begin_request(REQUEST).unwrap();

    let result = fixture.action("drop", &dropped).await.unwrap();
    assert!(result.operation.is_none());
    assert_eq!(fixture.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    let rewritten = fixture.git(&["rev-list", "--reverse", "HEAD", "--"]);
    let commits: Vec<_> = rewritten.lines().collect();
    assert_eq!(commits.len(), 3);
    assert_eq!(commits[0], root);
    assert_ne!(commits[1], old_first);
    assert_ne!(commits[2], old_tip);
    assert!(!commits.contains(&dropped.as_str()));
    assert_eq!(
        fixture.git(&["rev-parse", &format!("{}^1", commits[1])]),
        root
    );
    assert_eq!(fixture.git(&["rev-parse", "HEAD^1"]), commits[1]);
    assert_eq!(
        fixture.git(&["log", "-3", "--format=%s"]),
        "keep second\nkeep first\nroot"
    );
    assert!(!fixture.path.join("drop this.txt").exists());
    assert_eq!(
        fs::read(fixture.path.join("keep first 中文.txt")).unwrap(),
        b"first retained change\n"
    );
    assert_eq!(
        fs::read(fixture.path.join("keep second.txt")).unwrap(),
        b"second retained change\n"
    );
    assert_eq!(
        fixture.git(&["ls-tree", "--name-only", "HEAD", "--", "drop this.txt"]),
        ""
    );
    let state = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert!(state.files.is_empty() && state.operation.is_none());
}

#[tokio::test]
async fn rebase_and_drop_reject_each_dirty_state_without_stashing_or_changing_refs_or_index() {
    let fixture = Fixture::new();
    let root = fixture.git(&["rev-parse", "HEAD"]);
    fixture.write("candidate.txt", b"drop candidate\n");
    let candidate = fixture.commit("candidate commit");
    fixture.write("retained.txt", b"retained\n");
    let head = fixture.commit("retained commit");
    let _request = fixture.service.begin_request(REQUEST).unwrap();

    // Exercise unstaged-only, staged-only and untracked-only separately, so one
    // dirty category cannot hide an accidentally accepted second category.
    for category in ["unstaged", "staged", "untracked"] {
        match category {
            "unstaged" => fixture.write("base.txt", b"unstaged local content\n"),
            "staged" => {
                fixture.write("base.txt", b"staged local content\n");
                fixture.git(&["add", "--", "base.txt"]);
            }
            "untracked" => fixture.write("untracked 中文.txt", b"untracked local content\n"),
            _ => unreachable!(),
        }
        let before_status =
            fixture.git_bytes(&["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
        let before_refs = fixture.git_bytes(&["for-each-ref", "--format=%(refname) %(objectname)"]);
        let before_index = fixture.git_bytes(&["ls-files", "--stage", "-z"]);
        let before_tracked = fs::read(fixture.path.join("base.txt")).unwrap();
        assert!(!before_status.is_empty());
        for (kind, target) in [("rebase", root.as_str()), ("drop", candidate.as_str())] {
            let error = fixture.action(kind, target).await.unwrap_err();
            assert_eq!(
                error.code, "DIRTY_WORKTREE",
                "{kind} should refuse {category} changes: {error}"
            );
            assert_eq!(fixture.git(&["rev-parse", "HEAD"]), head);
            assert_eq!(fixture.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
            assert_eq!(
                fixture.git_bytes(&["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
                before_status
            );
            assert_eq!(
                fixture.git_bytes(&["for-each-ref", "--format=%(refname) %(objectname)"]),
                before_refs
            );
            assert_eq!(
                fixture.git_bytes(&["ls-files", "--stage", "-z"]),
                before_index
            );
            assert_eq!(
                fs::read(fixture.path.join("base.txt")).unwrap(),
                before_tracked
            );
            assert!(fixture
                .service
                .stashes(&fixture.repo, REQUEST)
                .await
                .unwrap()
                .is_empty());
            let state = fixture
                .service
                .working_state(&fixture.repo, REQUEST)
                .await
                .unwrap();
            assert!(state.operation.is_none());
            if category == "untracked" {
                assert_eq!(
                    fs::read(fixture.path.join("untracked 中文.txt")).unwrap(),
                    b"untracked local content\n"
                );
            }
        }
        fixture.git(&["reset", "--hard", "HEAD"]);
        if category == "untracked" {
            fs::remove_file(fixture.path.join("untracked 中文.txt")).unwrap();
        }
    }
}

#[tokio::test]
async fn external_diff_argv_uses_empty_tree_or_selected_commits_and_refuses_untracked_files() {
    let fixture = Fixture::new();
    let root = fixture.git(&["rev-parse", "HEAD"]);
    fixture.write("base.txt", b"second version\n");
    let tip = fixture.commit("second version");
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    // Compute through Git rather than assuming SHA-1's empty-tree constant.
    let empty_tree = fixture.git(&["hash-object", "-t", "tree", "--stdin"]);
    let make_query = |base: Option<&str>, target: &str, path: &str| DiffQuery {
        repo_id: fixture.repo.id.clone(),
        request_id: REQUEST.into(),
        base: base.map(str::to_owned),
        target: target.into(),
        path: path.into(),
        old_path: None,
        context: None,
        encoding: None,
        staged: None,
    };
    for base in [None, Some("ROOT")] {
        let query = make_query(base, &root, "base.txt");
        let args = fixture
            .service
            .external_diff_args(&fixture.repo, &query)
            .await
            .unwrap();
        let separator = args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(args[0], "difftool");
        assert!(args.iter().any(|arg| arg == "--no-prompt"));
        assert!(args.iter().any(|arg| arg == "--no-textconv"));
        assert_eq!(
            &args[separator - 2..separator],
            &[empty_tree.clone(), root.clone()]
        );
        assert_eq!(&args[separator + 1..], &[":(literal)base.txt"]);
    }
    let query = make_query(Some(&root), &tip, "base.txt");
    let args = fixture
        .service
        .external_diff_args(&fixture.repo, &query)
        .await
        .unwrap();
    let separator = args.iter().position(|arg| arg == "--").unwrap();
    assert_eq!(&args[separator - 2..separator], &[root, tip]);
    assert_eq!(&args[separator + 1..], &[":(literal)base.txt"]);
    fixture.write("untracked 中文.txt", b"built-in preview only\n");
    let query = make_query(Some("HEAD"), "WORKTREE", "untracked 中文.txt");
    let error = fixture
        .service
        .external_diff_args(&fixture.repo, &query)
        .await
        .unwrap_err();
    assert_eq!(error.code, "UNTRACKED_DIFF");
    assert_eq!(
        fs::read(fixture.path.join("untracked 中文.txt")).unwrap(),
        b"built-in preview only\n"
    );
    // Only inspect returned argv: never launch a user's configured difftool.
}

#[tokio::test]
async fn cancelling_a_queued_transaction_does_not_acquire_the_lock_or_poison_the_next_request() {
    use std::{future::Future, pin::Pin, task::Poll, time::Duration};
    use tokio::sync::oneshot;

    let service = GitService::new(None);
    let held = service.transaction("locked-fixture").await;
    let waiting_request = service.begin_request("waiting-transaction").unwrap();
    let worker_service = service.clone();
    let (queued_sender, queued_receiver) = oneshot::channel();
    let mut worker = tokio::spawn(async move {
        let mut pending =
            Box::pin(worker_service.transaction_for("locked-fixture", "waiting-transaction"));
        // Poll exactly once while the original guard is held. The notification
        // proves cancellation targets a genuinely queued lock, not a task that
        // merely has not started yet; no sleep/timing race is required.
        std::future::poll_fn(|context| match Pin::new(&mut pending).poll(context) {
            Poll::Pending => Poll::Ready(()),
            Poll::Ready(_) => panic!("queued transaction acquired an already held lock"),
        })
        .await;
        queued_sender.send(()).unwrap();
        pending.await
    });
    tokio::time::timeout(Duration::from_secs(5), queued_receiver)
        .await
        .expect("worker queues transaction promptly")
        .unwrap();
    service.cancel("waiting-transaction");
    let result = match tokio::time::timeout(Duration::from_secs(5), &mut worker).await {
        Ok(result) => result.expect("waiting worker joins"),
        Err(error) => {
            worker.abort();
            let _ = worker.await;
            panic!("cancelling a queued transaction timed out: {error}");
        }
    };
    match result {
        Err(error) => assert_eq!(error.code, "CANCELLED"),
        Ok(_) => panic!("cancelled request must not acquire the transaction"),
    }
    drop(waiting_request);
    // This guard stayed held until after cancellation completed.
    drop(held);
    let _next_request = service.begin_request("next-transaction").unwrap();
    let next = tokio::time::timeout(
        Duration::from_secs(5),
        service.transaction_for("locked-fixture", "next-transaction"),
    )
    .await
    .expect("next request is not blocked by the cancelled waiter")
    .unwrap();
    drop(next);
}
