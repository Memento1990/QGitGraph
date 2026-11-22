//! Independent, real-Git action regressions. No network, user config or upstream
//! implementation is used: each test owns its home, hooks, worktree and bares.

use qgitgraph_lib::{
    error::Result,
    git::GitService,
    model::{ActionResult, GitAction, Repository},
};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

const REQUEST: &str = "action-parity";
const TRACKED: &str = "tracked 中文.txt";

struct Fixture {
    directory: TempDir,
    home: PathBuf,
    path: PathBuf,
    template: PathBuf,
    hooks: PathBuf,
    service: GitService,
    repo: Repository,
    clock: Cell<u64>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-action-parity-")
            .tempdir()
            .unwrap();
        let home = directory.path().join("isolated 家目录");
        let path = directory.path().join("worktree 空 格");
        let template = directory.path().join("empty template");
        let hooks = directory.path().join("empty hooks");
        for path in [&home, &path, &template, &hooks] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "action-parity-repository".into(),
            path: path.to_string_lossy().into_owned(),
            name: "Action parity".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: true,
            bare: false,
        };
        let fixture = Self {
            directory,
            home,
            path,
            template,
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
            fixture.template.to_str().unwrap(),
        ]);
        for (key, value) in [
            ("user.name", "Parity 作者"),
            ("user.email", "parity@example.test"),
            ("core.autocrlf", "false"),
            ("core.filemode", "false"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.hooksPath", fixture.hooks.to_str().unwrap()),
        ] {
            fixture.git(&["config", "--local", key, value]);
        }
        fixture.write(TRACKED, b"base\n");
        fixture.commit("root");
        fixture
    }

    fn output_at(&self, path: &Path, args: &[&str]) -> Output {
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
        command
            .current_dir(path)
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
            .unwrap()
    }

    fn git_at(&self, path: &Path, args: &[&str]) -> String {
        let output = self.output_at(path, args);
        assert!(
            output.status.success(),
            "fixture Git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_owned()
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.path, args)
    }
    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }
    fn write(&self, path: &str, data: &[u8]) {
        fs::write(self.path.join(path), data).unwrap();
    }
    fn read(&self, path: &str) -> Vec<u8> {
        fs::read(self.path.join(path)).unwrap()
    }
    fn exists(&self, full: &str) -> bool {
        self.output_at(&self.path, &["show-ref", "--verify", "--quiet", full])
            .status
            .success()
    }
    fn commit(&self, message: &str) -> String {
        self.git(&["add", "--all", "--", "."]);
        self.clock.set(self.clock.get() + 60);
        self.git(&["commit", "--quiet", "--no-gpg-sign", "--message", message]);
        self.head()
    }
    fn bare(&self, name: &str) -> PathBuf {
        let path = self.directory.path().join(name);
        fs::create_dir_all(&path).unwrap();
        self.git_at(
            &path,
            &[
                "init",
                "--bare",
                "--quiet",
                "--initial-branch=main",
                "--template",
                self.template.to_str().unwrap(),
            ],
        );
        path
    }
    async fn action(&self, kind: &str, options: Value) -> Result<ActionResult> {
        let mut value = json!({"repoId":self.repo.id,"requestId":REQUEST,"kind":kind});
        value
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let action: GitAction = serde_json::from_value(value).unwrap();
        let _request = self.service.begin_request(REQUEST).unwrap();
        let _transaction = self
            .service
            .transaction_for(&self.repo.id, REQUEST)
            .await
            .unwrap();
        self.service.action(&self.repo, action).await
    }
    async fn origin(&self, path: &Path) {
        self.action(
            "remote-add",
            json!({"remote":"origin","url":path.to_str().unwrap()}),
        )
        .await
        .unwrap();
        self.action("push", json!({"remote":"origin","branch":"main"}))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn create_then_checkout_reports_partial_failure_without_discarding_work() {
    let f = Fixture::new();
    let root = f.head();
    let result = f
        .action(
            "branch-create",
            json!({"name":"创建/成功","checkoutAfter":true}),
        )
        .await
        .unwrap();
    assert_eq!(result.status.as_deref(), Some("completed"));
    assert!(result.session_id.is_none());
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/创建/成功");
    f.write(TRACKED, b"different branch content\n");
    let other = f.commit("different base");
    f.git(&["switch", "--quiet", "main"]);
    f.write(TRACKED, b"precious unstaged content\n");
    let error = f
        .action(
            "branch-create",
            json!({"name":"创建/保留","target":other,"checkoutAfter":true}),
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("created") && error.message.contains("checkout failed"));
    assert_eq!(f.git(&["rev-parse", "refs/heads/创建/保留"]), other);
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(f.head(), root);
    assert_eq!(f.read(TRACKED), b"precious unstaged content\n");
    assert!(f
        .action("branch-create", json!({"name":"创建/保留","target":root}))
        .await
        .is_err());
    assert_eq!(f.git(&["rev-parse", "refs/heads/创建/保留"]), other);
}

#[tokio::test]
async fn unicode_dot_slash_remote_checkout_creates_exact_tracking_without_overwrite() {
    let f = Fixture::new();
    let bare = f.bare("unicode 远端.git");
    let remote = "团队/镜像.一";
    f.action(
        "remote-add",
        json!({"remote":remote,"url":bare.to_str().unwrap()}),
    )
    .await
    .unwrap();
    f.action("push", json!({"remote":remote,"branch":"main"}))
        .await
        .unwrap();
    f.action("fetch", json!({"remote":remote})).await.unwrap();
    let full = format!("refs/remotes/{remote}/main");
    f.action(
        "checkout-remote",
        json!({"remote":remote,"target":full,"name":"跟踪/本地"}),
    )
    .await
    .unwrap();
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/跟踪/本地");
    assert_eq!(
        f.git(&["config", "--get", "branch.跟踪/本地.remote"]),
        remote
    );
    assert_eq!(
        f.git(&["config", "--get", "branch.跟踪/本地.merge"]),
        "refs/heads/main"
    );
    let before = f.head();
    assert!(f
        .action(
            "checkout-remote",
            json!({"remote":remote,"target":"main","name":"跟踪/本地"})
        )
        .await
        .is_err());
    assert_eq!(f.head(), before);
    let remotes = f
        .service
        .remotes(&f.repo, "parity-read-remotes")
        .await
        .unwrap();
    assert!(remotes.iter().any(|entry| entry.name == remote));
    let another = f.bare("另一个 push.git");
    f.action(
        "remote-edit",
        json!({"remote":remote,"mode":"push","url":another.to_str().unwrap()}),
    )
    .await
    .unwrap();
    f.action("push", json!({"remote":remote,"branch":"跟踪/本地"}))
        .await
        .unwrap();
    assert_eq!(
        f.git_at(&another, &["rev-parse", "refs/heads/跟踪/本地"]),
        before
    );
    assert_eq!(
        f.git(&["config", "--get", &format!("remote.{remote}.url")]),
        bare.to_str().unwrap()
    );
}

#[tokio::test]
async fn remote_delete_requires_explicit_remote_confirmation_and_observed_ref_lease() {
    let f = Fixture::new();
    let bare = f.bare("delete remote.git");
    f.origin(&bare).await;
    f.git(&["branch", "deletable"]);
    f.action("push", json!({"remote":"origin","branch":"deletable"}))
        .await
        .unwrap();
    assert_eq!(
        f.action(
            "remote-branch-delete",
            json!({"remote":"origin","target":"deletable"})
        )
        .await
        .unwrap_err()
        .code,
        "CONFIRMATION_REQUIRED"
    );
    assert!(f
        .action(
            "remote-branch-delete",
            json!({"target":"deletable","force":true})
        )
        .await
        .is_err());
    assert!(f
        .action(
            "remote-branch-delete",
            json!({"remote":"origin","target":"deletable:refs/heads/main","force":true})
        )
        .await
        .is_err());
    let observed = f.git(&["rev-parse", "refs/remotes/origin/deletable"]);
    f.write("advance.txt", b"new remote commit\n");
    let advance = f.commit("remote moved after observation");
    f.git(&[
        "push",
        "--",
        bare.to_str().unwrap(),
        "refs/heads/main:refs/heads/deletable",
    ]);
    assert_eq!(
        f.git(&["rev-parse", "refs/remotes/origin/deletable"]),
        observed
    );
    assert!(f
        .action(
            "remote-branch-delete",
            json!({"remote":"origin","target":"deletable","force":true})
        )
        .await
        .is_err());
    assert_eq!(
        f.git_at(&bare, &["rev-parse", "refs/heads/deletable"]),
        advance
    );
    f.action("fetch", json!({"remote":"origin","branch":"deletable"}))
        .await
        .unwrap();
    f.action(
        "remote-branch-delete",
        json!({"remote":"origin","target":"refs/remotes/origin/deletable","force":true}),
    )
    .await
    .unwrap();
    assert!(!f
        .output_at(
            &bare,
            &["show-ref", "--verify", "--quiet", "refs/heads/deletable"]
        )
        .status
        .success());
    assert!(f.exists("refs/heads/deletable"));
    assert!(f.exists("refs/heads/main"));
}

#[tokio::test]
async fn fetch_into_never_changes_checked_out_worktree_and_requires_explicit_nonff_force() {
    let f = Fixture::new();
    let root = f.head();
    let bare = f.bare("fetch into remote.git");
    f.origin(&bare).await;
    f.git(&["branch", "destination", &root]);
    f.write("incoming.txt", b"incoming\n");
    let incoming = f.commit("incoming commit");
    f.action("push", json!({"remote":"origin","branch":"main"}))
        .await
        .unwrap();
    f.git(&["reset", "--hard", &root]);
    f.write(TRACKED, b"staged precious work\n");
    f.git(&["add", "--", TRACKED]);
    f.write(TRACKED, b"unstaged precious work\n");
    f.write("untracked.txt", b"untracked precious work\n");
    let index = fs::read(f.path.join(".git/index")).unwrap();
    let error = f
        .action(
            "fetch-into",
            json!({"remote":"origin","target":"main","branch":"main","force":true}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "CHECKED_OUT_BRANCH");
    assert_eq!(fs::read(f.path.join(".git/index")).unwrap(), index);
    f.git(&[
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/*:refs/heads/*",
    ]);
    f.action(
        "fetch-into",
        json!({"remote":"origin","target":"main","branch":"destination"}),
    )
    .await
    .unwrap();
    assert_eq!(f.git(&["rev-parse", "refs/heads/destination"]), incoming);
    assert_eq!(f.head(), root);
    assert_eq!(
        f.git(&["show", &format!(":{TRACKED}")]),
        "staged precious work"
    );
    assert_eq!(f.read(TRACKED), b"unstaged precious work\n");
    assert_eq!(f.read("untracked.txt"), b"untracked precious work\n");
    f.git_at(&bare, &["update-ref", "refs/heads/main", &root]);
    assert!(f
        .action(
            "fetch-into",
            json!({"remote":"origin","target":"main","branch":"destination"})
        )
        .await
        .is_err());
    assert_eq!(f.git(&["rev-parse", "refs/heads/destination"]), incoming);
    f.action(
        "fetch-into",
        json!({"remote":"origin","target":"main","branch":"destination","force":true}),
    )
    .await
    .unwrap();
    assert_eq!(f.git(&["rev-parse", "refs/heads/destination"]), root);
    let linked = f.directory.path().join("linked worktree");
    f.git(&[
        "worktree",
        "add",
        "--quiet",
        linked.to_str().unwrap(),
        "destination",
    ]);
    assert_eq!(
        f.action(
            "fetch-into",
            json!({"remote":"origin","target":"main","branch":"destination","force":true})
        )
        .await
        .unwrap_err()
        .code,
        "CHECKED_OUT_BRANCH"
    );
    assert_eq!(f.read(TRACKED), b"unstaged precious work\n");
}

#[tokio::test]
async fn explicit_tag_types_push_real_tag_objects_and_report_partial_push_failure() {
    let f = Fixture::new();
    let bare = f.bare("tag remote.git");
    f.origin(&bare).await;
    f.action("tag-create", json!({"name":"轻量","tagType":"lightweight","sign":false,"pushAfter":true,"remote":"origin"})).await.unwrap();
    assert_eq!(
        f.git_at(&bare, &["cat-file", "-t", "refs/tags/轻量"]),
        "commit"
    );
    f.action("tag-create", json!({"name":"附注","tagType":"annotated","message":"发布说明 中文","pushAfter":true,"remote":"origin"})).await.unwrap();
    assert_eq!(f.git(&["cat-file", "-t", "refs/tags/附注"]), "tag");
    assert_eq!(
        f.git(&["rev-parse", "refs/tags/附注"]),
        f.git_at(&bare, &["rev-parse", "refs/tags/附注"])
    );
    assert!(f
        .action(
            "tag-create",
            json!({"name":"不应创建","tagType":"lightweight","message":"not ignored"})
        )
        .await
        .is_err());
    assert!(!f.exists("refs/tags/不应创建"));
    f.git(&["tag", "--delete", "轻量"]);
    f.write("next.txt", b"next release\n");
    let next = f.commit("next release");
    let error = f.action("tag-create", json!({"name":"轻量","tagType":"lightweight","sign":false,"pushAfter":true,"remote":"origin"})).await.unwrap_err();
    assert!(error.message.contains("created locally") && error.message.contains("push failed"));
    assert_eq!(f.git(&["rev-parse", "refs/tags/轻量"]), next);
    assert_ne!(f.git_at(&bare, &["rev-parse", "refs/tags/轻量"]), next);
}

#[tokio::test]
async fn unspecified_signing_follows_git_config_and_explicit_false_disables_it() {
    let f = Fixture::new();
    let nonexistent = f.directory.path().join("missing-signing-program.exe");
    f.git(&["config", "gpg.program", nonexistent.to_str().unwrap()]);
    f.git(&["config", "tag.gpgsign", "true"]);
    assert!(f
        .action(
            "tag-create",
            json!({"name":"configured-sign","tagType":"annotated","message":"must attempt signing"})
        )
        .await
        .is_err());
    assert!(!f.exists("refs/tags/configured-sign"));
    f.action("tag-create", json!({"name":"explicit-no-sign","tagType":"annotated","message":"unsigned by request","sign":false})).await.unwrap();
    assert_eq!(
        f.git(&["cat-file", "-t", "refs/tags/explicit-no-sign"]),
        "tag"
    );
    assert!(f
        .action(
            "tag-create",
            json!({"name":"no-silent-policy-change","tagType":"lightweight"})
        )
        .await
        .is_err());
    f.action(
        "tag-create",
        json!({"name":"light-no-sign","tagType":"lightweight","sign":false}),
    )
    .await
    .unwrap();
    f.git(&["switch", "--quiet", "--create", "source"]);
    f.write("pick.txt", b"pick me\n");
    let picked = f.commit("signed by config");
    f.git(&["switch", "--quiet", "main"]);
    f.git(&["config", "commit.gpgsign", "true"]);
    assert!(f
        .action("cherry-pick", json!({"target":picked}))
        .await
        .is_err());
    f.action("abort", json!({})).await.unwrap();
    f.action("cherry-pick", json!({"target":picked,"sign":false}))
        .await
        .unwrap();
    assert_eq!(f.read("pick.txt"), b"pick me\n");
}

#[tokio::test]
async fn stash_index_boolean_overrides_default_and_legacy_index_is_supported() {
    let f = Fixture::new();
    f.write(TRACKED, b"staged stash\n");
    f.git(&["add", "--", TRACKED]);
    f.write(TRACKED, b"unstaged stash\n");
    f.action("stash-save", json!({"message":"index split"}))
        .await
        .unwrap();
    f.action("stash-apply", json!({"reinstateIndex":false}))
        .await
        .unwrap();
    assert!(f.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(f.read(TRACKED), b"unstaged stash\n");
    f.git(&["reset", "--hard", "HEAD"]);
    f.action("stash-apply", json!({"reinstateIndex":true}))
        .await
        .unwrap();
    assert_eq!(f.git(&["show", &format!(":{TRACKED}")]), "staged stash");
    assert_eq!(f.read(TRACKED), b"unstaged stash\n");
    f.git(&["reset", "--hard", "HEAD"]);
    f.action("stash-apply", json!({"mode":"index"}))
        .await
        .unwrap();
    assert_eq!(f.git(&["show", &format!(":{TRACKED}")]), "staged stash");
    f.git(&["reset", "--hard", "HEAD"]);
    assert!(f
        .action("stash-pop", json!({"mode":"index","reinstateIndex":false}))
        .await
        .is_err());
    assert!(f.exists("refs/stash"));
    f.action(
        "stash-branch",
        json!({"name":"stash/without-index","reinstateIndex":false}),
    )
    .await
    .unwrap();
    assert_eq!(
        f.git(&["symbolic-ref", "HEAD"]),
        "refs/heads/stash/without-index"
    );
    assert!(f.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(f.read(TRACKED), b"unstaged stash\n");
    assert!(!f.exists("refs/stash"));
}

#[tokio::test]
async fn failed_stash_pop_retains_entry_and_real_unmerged_index() {
    let f = Fixture::new();
    f.write(TRACKED, b"stash side\n");
    f.action("stash-save", json!({"message":"conflicting stash"}))
        .await
        .unwrap();
    let stash = f.git(&["rev-parse", "refs/stash"]);
    f.write(TRACKED, b"new base side\n");
    let head = f.commit("conflicting current base");
    let error = f
        .action("stash-pop", json!({"reinstateIndex":false}))
        .await
        .unwrap_err();
    assert!(error.message.contains("retained"));
    assert_eq!(f.git(&["rev-parse", "refs/stash"]), stash);
    assert_eq!(f.head(), head);
    assert!(!f.git(&["ls-files", "--unmerged"]).is_empty());
    let working = String::from_utf8(f.read(TRACKED)).unwrap();
    assert!(working.contains("stash side") && working.contains("new base side"));
}

#[tokio::test]
async fn merge_cherry_pick_validates_actual_mainline_and_records_origin() {
    let f = Fixture::new();
    let root = f.head();
    f.git(&["switch", "--quiet", "--create", "left"]);
    f.write("left.txt", b"left\n");
    let left = f.commit("left parent");
    f.git(&["switch", "--quiet", "--create", "right", &root]);
    f.write("right.txt", b"right\n");
    f.commit("right parent");
    f.git(&["switch", "--quiet", "left"]);
    f.git(&["merge", "--no-ff", "--message", "two-parent merge", "right"]);
    let merge = f.head();
    f.git(&["switch", "--quiet", "main"]);
    for options in [
        json!({"target":merge}),
        json!({"target":merge,"mode":"mainline:3"}),
    ] {
        assert_eq!(
            f.action("cherry-pick", options).await.unwrap_err().code,
            "MAINLINE_REQUIRED"
        );
        assert_eq!(f.head(), root);
    }
    assert!(f
        .action("cherry-pick", json!({"target":left,"mode":"mainline:1"}))
        .await
        .is_err());
    f.action(
        "cherry-pick",
        json!({"target":merge,"mode":"mainline:1","recordOrigin":true,"sign":false}),
    )
    .await
    .unwrap();
    assert_eq!(f.read("right.txt"), b"right\n");
    assert!(!f.path.join("left.txt").exists());
    assert!(f
        .git(&["log", "-1", "--format=%B"])
        .contains(&format!("cherry picked from commit {merge}")));
    f.git(&["reset", "--hard", &root]);
    f.action(
        "cherry-pick",
        json!({"target":merge,"mode":"mainline:2","sign":false}),
    )
    .await
    .unwrap();
    assert_eq!(f.read("left.txt"), b"left\n");
    assert!(!f.path.join("right.txt").exists());
}

#[tokio::test]
async fn rebase_conflicts_keep_recovery_state_for_abort_and_continue() {
    let f = Fixture::new();
    f.git(&["switch", "--quiet", "--create", "topic"]);
    f.write(TRACKED, b"topic side\n");
    let old_topic = f.commit("topic conflict");
    f.git(&["switch", "--quiet", "main"]);
    f.write(TRACKED, b"upstream side\n");
    let upstream = f.commit("upstream conflict");
    f.git(&["switch", "--quiet", "topic"]);
    let options = json!({"target":upstream,"ignoreDate":true,"preserveMerges":true,"sign":false});
    assert!(f.action("rebase", options.clone()).await.is_err());
    assert!(f.path.join(".git/rebase-merge").is_dir());
    assert_eq!(
        f.service
            .working_state(&f.repo, "parity-rebase-read")
            .await
            .unwrap()
            .operation
            .as_deref(),
        Some("rebase")
    );
    f.action("abort", json!({})).await.unwrap();
    assert_eq!(f.head(), old_topic);
    assert_eq!(f.read(TRACKED), b"topic side\n");
    assert!(f.action("rebase", options).await.is_err());
    f.write(TRACKED, b"reviewed resolution\n");
    f.git(&["add", "--", TRACKED]);
    let result = f.action("continue", json!({})).await.unwrap();
    assert!(result.operation.is_none());
    assert!(!f.path.join(".git/rebase-merge").exists());
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
    assert_eq!(f.git(&["rev-parse", "HEAD^1"]), upstream);
    assert_eq!(f.read(TRACKED), b"reviewed resolution\n");
}

#[tokio::test]
async fn preserve_merges_rebase_keeps_topology_but_drop_root_and_merge_stay_guarded() {
    let f = Fixture::new();
    let root = f.head();
    f.git(&["switch", "--quiet", "--create", "side"]);
    f.write("side.txt", b"side\n");
    f.commit("side commit");
    f.git(&["switch", "--quiet", "--create", "topic", &root]);
    f.write("topic.txt", b"topic\n");
    f.commit("topic commit");
    f.git(&["merge", "--no-ff", "--message", "topic merge", "side"]);
    let old_merge = f.head();
    assert_eq!(
        f.action("drop", json!({"target":root}))
            .await
            .unwrap_err()
            .code,
        "DROP_ROOT_UNSUPPORTED"
    );
    assert_eq!(
        f.action("drop", json!({"target":old_merge}))
            .await
            .unwrap_err()
            .code,
        "DROP_MERGE_UNSUPPORTED"
    );
    assert_eq!(f.head(), old_merge);
    f.git(&["switch", "--quiet", "main"]);
    f.write("upstream.txt", b"upstream\n");
    let upstream = f.commit("new upstream");
    f.git(&["switch", "--quiet", "topic"]);
    f.action(
        "rebase",
        json!({"target":upstream,"ignoreDate":true,"preserveMerges":true,"sign":false}),
    )
    .await
    .unwrap();
    let parents = f.git(&["rev-list", "--parents", "--max-count=1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 3);
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
    for name in ["side.txt", "topic.txt", "upstream.txt"] {
        assert!(f.path.join(name).is_file());
    }
    assert!(!f
        .git(&["rev-list", "--merges", &format!("{upstream}..HEAD")])
        .is_empty());
}

#[tokio::test]
async fn fetch_prune_and_tag_prune_are_explicit_not_enabled_by_repository_config() {
    let f = Fixture::new();
    let bare = f.bare("prune remote.git");
    f.origin(&bare).await;
    let root = f.head();
    f.git(&["tag", "--no-sign", "local-only"]);
    f.git(&["update-ref", "refs/remotes/origin/ghost", &root]);
    f.git(&["config", "fetch.prune", "true"]);
    f.git(&["config", "fetch.prunetags", "true"]);
    f.git(&["config", "remote.origin.prune", "true"]);
    f.git(&["config", "remote.origin.prunetags", "true"]);
    f.action("fetch", json!({"remote":"origin"})).await.unwrap();
    assert!(f.exists("refs/tags/local-only"));
    assert!(f.exists("refs/remotes/origin/ghost"));
    f.action(
        "fetch",
        json!({"remote":"origin","prune":true,"pruneTags":false}),
    )
    .await
    .unwrap();
    assert!(!f.exists("refs/remotes/origin/ghost"));
    assert!(f.exists("refs/tags/local-only"));
    assert!(f
        .action("fetch", json!({"remote":"origin","pruneTags":true}))
        .await
        .is_err());
    assert!(f.exists("refs/tags/local-only"));
    f.action(
        "fetch",
        json!({"remote":"origin","prune":true,"pruneTags":true}),
    )
    .await
    .unwrap();
    assert!(!f.exists("refs/tags/local-only"));
}

#[tokio::test]
async fn squash_pull_summary_leaves_reviewed_index_then_explicit_followup_commit() {
    let f = Fixture::new();
    let root = f.head();
    let bare = f.bare("squash remote.git");
    f.origin(&bare).await;
    f.write("first.txt", b"first remote change\n");
    f.commit("first remote subject");
    f.write("second.txt", b"second remote change\n");
    f.commit("second remote subject");
    f.action("push", json!({"remote":"origin","branch":"main"}))
        .await
        .unwrap();
    f.git(&["reset", "--hard", &root]);
    let result = f.action("pull", json!({"remote":"origin","branch":"main","mode":"merge","squash":true,"squashMessage":"summary","sign":false})).await.unwrap();
    assert_eq!(f.head(), root);
    assert!(result.output.contains("review"));
    let message = fs::read_to_string(f.path.join(".git/SQUASH_MSG")).unwrap();
    assert!(message.starts_with("Squash summary"));
    assert!(message.contains("first remote subject") && message.contains("second remote subject"));
    assert!(!f.git(&["diff", "--cached", "--name-only"]).is_empty());
    f.action("commit", json!({"sign":false})).await.unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD^1"]), root);
    assert!(f
        .git(&["log", "-1", "--format=%B"])
        .contains("Squash summary"));
    assert_eq!(f.read("first.txt"), b"first remote change\n");
    assert_eq!(f.read("second.txt"), b"second remote change\n");
}

#[tokio::test]
async fn bad_option_combinations_fail_before_pull_fetch_or_local_creation() {
    let f = Fixture::new();
    let bare = f.bare("validation remote.git");
    f.origin(&bare).await;
    let observed = f.git(&["rev-parse", "refs/remotes/origin/main"]);
    f.write("remote.txt", b"remote advance\n");
    f.commit("unobserved advance");
    f.git(&[
        "push",
        "--",
        bare.to_str().unwrap(),
        "refs/heads/main:refs/heads/main",
    ]);
    f.git(&["reset", "--hard", &observed]);
    for extra in [
        json!({"remote":"origin","mode":"rebase","noFastForward":true}),
        json!({"remote":"origin","mode":"merge","ignoreDate":true}),
        json!({"remote":"origin","mode":"merge","preserveMerges":false}),
        json!({"remote":"origin","mode":"ff-only","squash":true}),
        json!({"remote":"origin","mode":"merge","squashMessage":"summary"}),
    ] {
        assert!(f.action("pull", extra).await.is_err());
        assert_eq!(f.git(&["rev-parse", "refs/remotes/origin/main"]), observed);
    }
    for expression in ["HEAD~1", "HEAD^{tree}", "main..other", "--all", "HEAD:path"] {
        assert!(f
            .action(
                "branch-create",
                json!({"name":"never-created","target":expression})
            )
            .await
            .is_err());
        assert!(!f.exists("refs/heads/never-created"));
    }
}

#[tokio::test]
async fn url_credentials_rewrites_and_helpers_are_preflighted_without_leaking_secrets() {
    let f = Fixture::new();
    for (index, url) in [
        "https://username:supersecret@example.invalid/repo.git",
        "https://access-token-secret@example.invalid/repo.git",
        "ssh://git:sshsecret@example.invalid/repo.git",
        "https://example.invalid/repo?token=querysecret",
    ]
    .iter()
    .enumerate()
    {
        let remote = format!("credential-{index}");
        let error = f
            .action("remote-add", json!({"remote":remote,"url":url}))
            .await
            .unwrap_err();
        let rendered = error.to_string();
        for secret in [
            "supersecret",
            "access-token-secret",
            "sshsecret",
            "querysecret",
        ] {
            assert!(!rendered.contains(secret));
        }
        assert!(!f.git(&["remote"]).lines().any(|name| name == remote));
    }
    f.git(&[
        "config",
        "url.ext::false.insteadOf",
        "https://rewritten.invalid/",
    ]);
    assert!(f
        .action(
            "remote-add",
            json!({"remote":"rewritten","url":"https://rewritten.invalid/repo.git"})
        )
        .await
        .is_err());
    assert!(!f.git(&["remote"]).contains("rewritten"));
    f.git(&[
        "config",
        "url.ext::false.pushInsteadOf",
        "https://push-rewritten.invalid/",
    ]);
    assert!(f
        .action(
            "remote-add",
            json!({"remote":"push-rewritten","url":"https://push-rewritten.invalid/repo.git"})
        )
        .await
        .is_err());
    f.git(&[
        "remote",
        "add",
        "unsafe",
        "https://user:oldsecret@example.invalid/repo.git",
    ]);
    let error = f
        .action("fetch", json!({"remote":"unsafe"}))
        .await
        .unwrap_err();
    assert!(!error.to_string().contains("oldsecret"));
    f.git(&["remote", "remove", "unsafe"]);
    f.git(&[
        "config",
        "remote.embedded-newline.url",
        "https://one.invalid/repo\nhttps://two.invalid/repo",
    ]);
    assert!(f
        .action("fetch", json!({"remote":"embedded-newline"}))
        .await
        .is_err());
    f.git(&["remote", "remove", "embedded-newline"]);
    let bare = f.bare("preflight safe.git");
    f.git(&["remote", "add", "a-safe", bare.to_str().unwrap()]);
    f.git(&["remote", "add", "z-helper", "ext::false"]);
    assert!(f.action("fetch", json!({"remote":""})).await.is_err());
    assert!(!f.exists("refs/remotes/a-safe/main"));
}
