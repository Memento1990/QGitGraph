//! Real-Git working mutations. Every worktree, remote, hook and home is owned by
//! a fresh TempDir. These tests never discover or mutate the developer profile.

use qgitgraph_lib::{
    error::Result,
    git::{sanitize_environment, GitService},
    model::{ActionResult, Repository, RepositorySnapshot, WorkingAction},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

const REQUEST: &str = "working-action-fixture";

struct Fixture {
    directory: TempDir,
    home: PathBuf,
    path: PathBuf,
    hooks: PathBuf,
    template: PathBuf,
    service: GitService,
    repo: Repository,
}

impl Fixture {
    fn unborn() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-working-")
            .tempdir()
            .unwrap();
        let home = directory.path().join("isolated home 中文");
        let path = directory.path().join("worktree with 空格");
        let hooks = directory.path().join("empty hooks");
        let template = directory.path().join("empty template");
        for directory in [&home, &path, &hooks, &template] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "working-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "Working fixture".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: true,
            bare: false,
        };
        let f = Self {
            directory,
            home,
            path,
            hooks,
            template,
            service,
            repo,
        };
        f.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--template",
            f.template.to_str().unwrap(),
        ]);
        f.configure(&f.path);
        f
    }

    fn new() -> Self {
        let f = Self::unborn();
        f.write("tracked.txt", b"base\n");
        f.commit("root");
        f
    }

    fn configure(&self, path: &Path) {
        for (key, value) in [
            ("user.name", "Working 作者"),
            ("user.email", "working@example.test"),
            ("core.autocrlf", "false"),
            ("core.filemode", "false"),
            ("commit.gpgSign", "false"),
            ("tag.gpgSign", "false"),
            ("core.hooksPath", self.hooks.to_str().unwrap()),
        ] {
            self.git_at(path, &["config", "--local", key, value]);
        }
    }

    fn output_at(&self, path: &Path, args: &[&str]) -> Output {
        let mut command = Command::new(self.service.git_path());
        sanitize_environment(&mut command, true, false, Some(&self.home));
        command
            .current_dir(path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "false")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_PAGER", "cat")
            .args([
                "--no-pager",
                "-c",
                "core.autocrlf=false",
                "-c",
                "commit.gpgSign=false",
                "-c",
            ])
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
    fn write(&self, path: &str, content: &[u8]) {
        fs::write(self.path.join(path), content).unwrap();
    }
    fn read(&self, path: &str) -> Vec<u8> {
        fs::read(self.path.join(path)).unwrap()
    }
    fn index(&self, path: &str) -> String {
        self.git(&["show", &format!(":{path}")])
    }
    fn commit(&self, message: &str) -> String {
        self.git(&["add", "--all", "--", "."]);
        self.git(&["commit", "--quiet", "--no-gpg-sign", "--message", message]);
        self.head()
    }

    fn hook(&self, name: &str, content: &[u8]) {
        let path = self.hooks.join(name);
        fs::write(&path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn dto(&self, kind: &str, options: Value) -> WorkingAction {
        let mut value = json!({"repoId": self.repo.id, "requestId": REQUEST, "kind": kind});
        value
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    async fn action(&self, kind: &str, options: Value) -> Result<ActionResult> {
        let _request = self.service.begin_request(REQUEST)?;
        let _transaction = self
            .service
            .repository_transaction(&self.repo, REQUEST)
            .await?;
        self.service
            .working_action(&self.repo, self.dto(kind, options))
            .await
    }

    async fn token(&self) -> String {
        let _request = self.service.begin_request("working-token").unwrap();
        let _transaction = self
            .service
            .repository_transaction(&self.repo, "working-token")
            .await
            .unwrap();
        self.service
            .working_index(&self.repo, "working-token")
            .await
            .unwrap()
    }

    async fn repository_snapshot(&self) -> RepositorySnapshot {
        let request = "working-snapshot";
        let _request = self.service.begin_request(request).unwrap();
        let _transaction = self
            .service
            .repository_transaction(&self.repo, request)
            .await
            .unwrap();
        self.service.snapshot(&self.repo, request).await.unwrap()
    }

    async fn commit_options(&self, message: &str) -> Value {
        let head = self.output_at(&self.path, &["rev-parse", "--verify", "HEAD"]);
        let head = if head.status.success() {
            Some(String::from_utf8(head.stdout).unwrap().trim().to_owned())
        } else {
            None
        };
        json!({"message": message, "expectedHead": head, "expectedIndex": self.token().await, "sign": false})
    }

    fn submodule(&self, name: &str) -> (PathBuf, String) {
        let source = self.directory.path().join("child source 中文");
        fs::create_dir(&source).unwrap();
        self.git_at(
            &source,
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                "--template",
                self.template.to_str().unwrap(),
            ],
        );
        self.configure(&source);
        fs::write(source.join("child.txt"), b"recorded child\n").unwrap();
        self.git_at(&source, &["add", "--", "child.txt"]);
        self.git_at(
            &source,
            &["commit", "--quiet", "--message", "child recorded"],
        );
        self.git(&[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            "--",
            source.to_str().unwrap(),
            name,
        ]);
        let child = self.path.join(name);
        self.configure(&child);
        self.commit("parent recorded child");
        let recorded = self.git_at(&child, &["rev-parse", "HEAD"]);
        (child, recorded)
    }

    fn advance_child(&self, child: &Path, content: &[u8]) -> String {
        fs::write(child.join("child.txt"), content).unwrap();
        self.git_at(child, &["add", "--", "child.txt"]);
        self.git_at(
            child,
            &["commit", "--quiet", "--message", "advance fixture child"],
        );
        self.git_at(child, &["rev-parse", "HEAD"])
    }

    // Snapshot bytes, not just status, so child index/refs/config/object writes
    // cannot pass as read-only. All inputs remain owned by this TempDir.
    fn snapshot(&self, directory: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn visit(root: &Path, directory: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                let metadata = fs::symlink_metadata(&path).unwrap();
                assert!(!metadata.file_type().is_symlink());
                if metadata.is_dir() {
                    visit(root, &path, out);
                } else {
                    out.push((
                        path.strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(path).unwrap(),
                    ));
                }
            }
        }
        let mut files = Vec::new();
        visit(directory, directory, &mut files);
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
    }

    fn child_git_dir(&self, child: &Path) -> PathBuf {
        PathBuf::from(self.git_at(child, &["rev-parse", "--absolute-git-dir"]))
    }

    fn remote(&self) -> (PathBuf, PathBuf) {
        let bare = self.directory.path().join("bare remote 中文.git");
        fs::create_dir_all(&bare).unwrap();
        self.git_at(
            &bare,
            &[
                "init",
                "--bare",
                "--quiet",
                "--initial-branch=remote-trunk",
                "--template",
                self.template.to_str().unwrap(),
            ],
        );
        self.git(&["remote", "add", "team.backup", bare.to_str().unwrap()]);
        self.git(&[
            "push",
            "--quiet",
            "--set-upstream",
            "team.backup",
            "refs/heads/main:refs/heads/remote-trunk",
        ]);
        let peer = self.directory.path().join("other worktree");
        self.git_at(
            self.directory.path(),
            &[
                "clone",
                "--quiet",
                "--template",
                self.template.to_str().unwrap(),
                bare.to_str().unwrap(),
                peer.to_str().unwrap(),
            ],
        );
        self.configure(&peer);
        (bare, peer)
    }
}

#[tokio::test]
async fn literal_special_names_are_bounded_for_stage_unstage_and_discard() {
    let f = Fixture::new();
    for name in ["file[ab].txt", "filea.txt", "-option.txt", "空 格.txt"] {
        f.write(name, b"initial\n");
    }
    f.commit("special names");
    for name in ["file[ab].txt", "filea.txt", "-option.txt", "空 格.txt"] {
        f.write(name, b"modified\n");
    }
    f.action(
        "stage",
        json!({"files":[{"path":"file[ab].txt"},{"path":"-option.txt"},{"path":"空 格.txt"}]}),
    )
    .await
    .unwrap();
    assert_eq!(f.index("file[ab].txt"), "modified");
    assert_eq!(f.index("-option.txt"), "modified");
    assert_eq!(f.index("空 格.txt"), "modified");
    assert_eq!(f.index("filea.txt"), "initial");
    f.action("unstage", json!({"files":[{"path":"file[ab].txt"}]}))
        .await
        .unwrap();
    assert_eq!(f.index("file[ab].txt"), "initial");
    assert_eq!(f.index("-option.txt"), "modified");
    f.action(
        "discard",
        json!({"files":[{"path":"file[ab].txt"}],"confirmation":"discard"}),
    )
    .await
    .unwrap();
    assert_eq!(f.read("file[ab].txt"), b"initial\n");
    assert_eq!(f.read("filea.txt"), b"modified\n");
    assert_eq!(f.read("-option.txt"), b"modified\n");
}

#[tokio::test]
async fn stage_does_not_expand_a_directory_or_stale_pathspec_to_the_repository() {
    let f = Fixture::new();
    fs::create_dir(f.path.join("directory")).unwrap();
    f.write("directory/one.txt", b"one\n");
    f.write("directory/two.txt", b"two\n");
    f.write("tracked.txt", b"important\n");
    for bad in [
        ".",
        "..",
        "../outside",
        "/absolute",
        "C:/absolute",
        "a/../b",
        ".git/config",
        "x/.GiT/config",
        "a\\b",
        ":(glob)**",
        "directory",
        "directory/",
    ] {
        assert!(
            f.action("stage", json!({"files":[{"path":bad}]}))
                .await
                .is_err(),
            "{bad}"
        );
    }
    assert!(f.action("stage", json!({"files":[]})).await.is_err());
    assert!(f
        .action(
            "stage",
            json!({"files":[{"path":"directory/one.txt","oldPath":"tracked.txt"}]})
        )
        .await
        .is_err());
    assert!(f.git(&["diff", "--cached", "--name-only"]).is_empty());
    f.action("stage", json!({"files":[{"path":"directory/one.txt"}]}))
        .await
        .unwrap();
    assert_eq!(
        f.git(&["diff", "--cached", "--name-only"]),
        "directory/one.txt"
    );
    assert_eq!(f.read("tracked.txt"), b"important\n");
}

#[tokio::test]
async fn discard_only_restores_index_and_preserves_staged_and_unrelated_changes() {
    let f = Fixture::new();
    f.write("tracked.txt", b"staged\n");
    f.git(&["add", "--", "tracked.txt"]);
    f.write("tracked.txt", b"unstaged\n");
    f.write("other.txt", b"keep untracked\n");
    let index = f.git(&["ls-files", "--stage", "-z"]);
    assert!(f
        .action("discard", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .is_err());
    f.action(
        "discard",
        json!({"files":[{"path":"tracked.txt","status":"MM"}],"confirmation":"discard"}),
    )
    .await
    .unwrap();
    assert_eq!(f.read("tracked.txt"), b"staged\n");
    assert_eq!(f.index("tracked.txt"), "staged");
    assert_eq!(f.git(&["ls-files", "--stage", "-z"]), index);
    assert_eq!(f.read("other.txt"), b"keep untracked\n");
    assert!(f
        .action(
            "discard",
            json!({"files":[{"path":"other.txt"}],"confirmation":"discard"})
        )
        .await
        .is_err());
}

#[tokio::test]
async fn rename_stage_and_unstage_cover_both_paths_without_losing_worktree() {
    let f = Fixture::new();
    fs::rename(f.path.join("tracked.txt"), f.path.join("renamed[1].txt")).unwrap();
    f.action(
        "stage",
        json!({"files":[{"path":"renamed[1].txt","oldPath":"tracked.txt","status":"?"}]}),
    )
    .await
    .unwrap();
    let state = f
        .service
        .working_state(&f.repo, "rename-read")
        .await
        .unwrap();
    assert_eq!(state.files[0].old_path.as_deref(), Some("tracked.txt"));
    f.write("renamed[1].txt", b"unstaged after rename\n");
    let index = f.index("renamed[1].txt");
    f.action("discard", json!({"files":[{"path":"renamed[1].txt","oldPath":"tracked.txt"}],"confirmation":"discard"})).await.unwrap();
    assert_eq!(
        String::from_utf8(f.read("renamed[1].txt")).unwrap().trim(),
        index
    );
    f.write("renamed[1].txt", b"next staged version\n");
    // Its source is already absent from both disk and index. Re-staging the
    // destination must not fail or broaden to another worktree path.
    f.action(
        "stage",
        json!({"files":[{"path":"renamed[1].txt","oldPath":"tracked.txt"}]}),
    )
    .await
    .unwrap();
    assert_eq!(f.index("renamed[1].txt"), "next staged version");
    f.action(
        "unstage",
        json!({"files":[{"path":"renamed[1].txt","oldPath":"tracked.txt"}]}),
    )
    .await
    .unwrap();
    assert!(f.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(f.index("tracked.txt"), "base");
    assert!(!f.path.join("tracked.txt").exists());
    assert_eq!(f.read("renamed[1].txt"), b"next staged version\n");
}

#[tokio::test]
async fn staging_renamed_destination_never_stages_a_recreated_private_source() {
    let f = Fixture::new();
    fs::rename(f.path.join("tracked.txt"), f.path.join("renamed.txt")).unwrap();
    f.action(
        "stage",
        json!({"files":[{"path":"renamed.txt","oldPath":"tracked.txt"}]}),
    )
    .await
    .unwrap();
    f.write("tracked.txt", b"PRIVATE recreated untracked source\n");
    f.write("renamed.txt", b"base\nnew line\n");
    f.action(
        "stage",
        json!({"files":[{"path":"renamed.txt","oldPath":"tracked.txt"}]}),
    )
    .await
    .unwrap();
    assert!(!f
        .output_at(&f.path, &["cat-file", "-e", ":tracked.txt"])
        .status
        .success());
    assert_eq!(f.index("renamed.txt"), "base\nnew line");
    assert_eq!(
        f.read("tracked.txt"),
        b"PRIVATE recreated untracked source\n"
    );
    let state = f
        .service
        .working_state(&f.repo, "rename-private-read")
        .await
        .unwrap();
    assert!(state
        .files
        .iter()
        .any(|file| file.path == "tracked.txt" && file.status == "?"));
    f.write("renamed.txt", b"base\nnew line\nanother line\n");
    f.action("stage", json!({"files":[{"path":"renamed.txt"}]}))
        .await
        .unwrap();
    assert!(!f
        .output_at(&f.path, &["cat-file", "-e", ":tracked.txt"])
        .status
        .success());
    assert_eq!(f.index("renamed.txt"), "base\nnew line\nanother line");
    assert_eq!(
        f.read("tracked.txt"),
        b"PRIVATE recreated untracked source\n"
    );
}

#[tokio::test]
async fn unborn_unstage_keeps_worktree_and_other_staged_entries_then_commits_index_only() {
    let f = Fixture::unborn();
    f.write("first.txt", b"first staged\n");
    f.write("second.txt", b"second staged\n");
    f.action(
        "stage",
        json!({"files":[{"path":"first.txt"},{"path":"second.txt"}]}),
    )
    .await
    .unwrap();
    f.write("first.txt", b"first unstaged\n");
    f.action("unstage", json!({"files":[{"path":"first.txt"}]}))
        .await
        .unwrap();
    assert_eq!(f.read("first.txt"), b"first unstaged\n");
    assert_eq!(f.git(&["ls-files"]), "second.txt");
    let options = f.commit_options("initial commit").await;
    let result = f.action("commit-staged", options).await.unwrap();
    assert_eq!(result.status.as_deref(), Some("completed"));
    assert_eq!(f.git(&["ls-tree", "--name-only", "HEAD"]), "second.txt");
    assert_eq!(f.read("first.txt"), b"first unstaged\n");
}

#[tokio::test]
async fn gitlink_stage_snapshots_v1_and_parent_commit_never_rereads_child_v2() {
    let f = Fixture::new();
    let name = "module[1] 中文";
    let (child, recorded) = f.submodule(name);
    let v1 = f.advance_child(&child, b"child v1\n");
    let child_git = f.child_git_dir(&child);
    let before_child = f.snapshot(&child);
    let before_git = f.snapshot(&child_git);
    let parent_head = f.head();
    let parent_config = f.read(".git/config");
    let regular_index = f.git(&["ls-files", "--stage", "--", "tracked.txt"]);
    f.write("tracked.txt", b"unselected parent change\n");
    f.action(
        "stage",
        json!({"files":[{"path":name}],"expectedIndex":f.token().await}),
    )
    .await
    .unwrap();
    assert_eq!(
        f.git(&["ls-files", "--stage", "-z", "--", name]),
        format!("160000 {v1} 0\t{name}\0")
    );
    assert_eq!(f.git(&["rev-parse", &format!("HEAD:{name}")]), recorded);
    assert_eq!(f.head(), parent_head);
    assert_eq!(f.read(".git/config"), parent_config);
    assert_eq!(
        f.git(&["ls-files", "--stage", "--", "tracked.txt"]),
        regular_index
    );
    assert_eq!(f.snapshot(&child), before_child);
    assert_eq!(f.snapshot(&child_git), before_git);

    let v2 = f.advance_child(&child, b"child v2\n");
    let options = f.commit_options("parent captures staged v1 only").await;
    let before_child = f.snapshot(&child);
    let before_git = f.snapshot(&child_git);
    f.action("commit-staged", options).await.unwrap();
    assert_eq!(
        f.git(&["ls-tree", "-z", "HEAD", "--", name]),
        format!("160000 commit {v1}\t{name}\0")
    );
    assert_eq!(f.git_at(&child, &["rev-parse", "HEAD"]), v2);
    assert_eq!(f.snapshot(&child), before_child);
    assert_eq!(f.snapshot(&child_git), before_git);
    assert_eq!(f.read(".git/config"), parent_config);
    assert_eq!(f.git(&["show", "HEAD:tracked.txt"]), "base");
    assert_eq!(f.read("tracked.txt"), b"unselected parent change\n");
}

#[tokio::test]
async fn gitlink_unstage_restores_recorded_oid_without_child_or_other_index_writes() {
    let f = Fixture::new();
    let name = "module";
    let (child, recorded) = f.submodule(name);
    let v1 = f.advance_child(&child, b"child v1\n");
    f.action("stage", json!({"files":[{"path":name}]}))
        .await
        .unwrap();
    f.write("tracked.txt", b"keep staged parent\n");
    f.action("stage", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .unwrap();
    let v2 = f.advance_child(&child, b"child v2\n");
    let child_git = f.child_git_dir(&child);
    let child_before = f.snapshot(&child);
    let git_before = f.snapshot(&child_git);
    let parent_head = f.head();
    let regular_index = f.git(&["ls-files", "--stage", "--", "tracked.txt"]);
    assert_eq!(f.git(&["rev-parse", ":module"]), v1);
    f.action("unstage", json!({"files":[{"path":name}]}))
        .await
        .unwrap();
    assert_eq!(
        f.git(&["ls-files", "--stage", "--", name]),
        format!("160000 {recorded} 0\t{name}")
    );
    assert_eq!(f.git_at(&child, &["rev-parse", "HEAD"]), v2);
    assert_eq!(f.head(), parent_head);
    assert_eq!(
        f.git(&["ls-files", "--stage", "--", "tracked.txt"]),
        regular_index
    );
    assert_eq!(f.snapshot(&child), child_before);
    assert_eq!(f.snapshot(&child_git), git_before);
}

#[tokio::test]
async fn gitlink_dirty_child_cannot_fake_parent_staging_or_leak_child_content() {
    let f = Fixture::new();
    let name = "module";
    let (child, recorded) = f.submodule(name);
    fs::write(child.join("child.txt"), b"child staged but uncommitted\n").unwrap();
    f.git_at(&child, &["add", "--", "child.txt"]);
    fs::write(child.join("child.txt"), b"private dirty child\n").unwrap();
    fs::write(child.join("untracked.txt"), b"private untracked child\n").unwrap();
    let child_git = f.child_git_dir(&child);
    let parent_index = f.read(".git/index");
    let child_before = f.snapshot(&child);
    let git_before = f.snapshot(&child_git);
    let error = f
        .action("stage", json!({"files":[{"path":name}]}))
        .await
        .unwrap_err();
    assert_eq!(error.code, "INVALID_WORKING_ACTION");
    assert_eq!(f.read(".git/index"), parent_index);
    assert_eq!(f.git(&["rev-parse", ":module"]), recorded);
    assert!(f.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(f.snapshot(&child), child_before);
    assert_eq!(f.snapshot(&child_git), git_before);

    // Dirty/staged/untracked content remains private even when HEAD advances.
    f.git_at(
        &child,
        &[
            "commit",
            "--quiet",
            "--message",
            "child v1 from child index",
        ],
    );
    let v1 = f.git_at(&child, &["rev-parse", "HEAD"]);
    let child_before = f.snapshot(&child);
    let git_before = f.snapshot(&child_git);
    f.action("stage", json!({"files":[{"path":name}]}))
        .await
        .unwrap();
    assert_eq!(
        f.git(&["ls-files", "--stage", "-z", "--", name]),
        format!("160000 {v1} 0\t{name}\0")
    );
    assert_eq!(
        f.git(&["ls-files", "--", "module/child.txt", "module/untracked.txt"]),
        ""
    );
    assert_eq!(f.snapshot(&child), child_before);
    assert_eq!(f.snapshot(&child_git), git_before);
}

#[tokio::test]
async fn gitlink_descendants_discard_and_delete_remain_rejected_with_parent_child_integrity() {
    let f = Fixture::new();
    let (child, _) = f.submodule("module");
    f.advance_child(&child, b"child v1\n");
    f.action("stage", json!({"files":[{"path":"module"}]}))
        .await
        .unwrap();
    fs::write(child.join("child.txt"), b"private dirty child\n").unwrap();
    let child_git = f.child_git_dir(&child);
    let child_before = f.snapshot(&child);
    let git_before = f.snapshot(&child_git);
    let parent_index = f.read(".git/index");
    let parent_head = f.head();
    let parent_config = f.read(".git/config");
    for path in [
        "module",
        "module/child.txt",
        "module/.git/HEAD",
        "module/../tracked.txt",
    ] {
        for kind in ["stage", "unstage", "discard", "delete-untracked"] {
            if path == "module" && matches!(kind, "stage" | "unstage") {
                continue;
            }
            let mut options = json!({"files":[{"path":path}]});
            if kind == "discard" {
                options["confirmation"] = json!("discard");
            }
            if kind == "delete-untracked" {
                options["confirmation"] = json!(path);
            }
            assert!(f.action(kind, options).await.is_err(), "{kind} {path}");
            assert_eq!(f.read(".git/index"), parent_index);
        }
    }
    assert_eq!(f.head(), parent_head);
    assert_eq!(f.read(".git/config"), parent_config);
    assert_eq!(f.snapshot(&child), child_before);
    assert_eq!(f.snapshot(&child_git), git_before);
}

#[tokio::test]
async fn gitlink_uninitialized_placeholder_and_escaping_gitdir_are_never_initialized_or_staged() {
    let f = Fixture::new();
    let (child, _) = f.submodule("module");
    f.advance_child(&child, b"child v1\n");
    f.action("stage", json!({"files":[{"path":"module"}]}))
        .await
        .unwrap();
    f.git(&["submodule", "deinit", "--force", "--", "module"]);
    let index = f.read(".git/index");
    let config = f.read(".git/config");
    let modules = f.path.join(".git/modules");
    let modules_before = f.snapshot(&modules);
    for kind in ["stage", "unstage"] {
        assert!(f
            .action(kind, json!({"files":[{"path":"module"}]}))
            .await
            .is_err());
    }
    assert!(!child.join(".git").exists());
    assert_eq!(f.read(".git/index"), index);
    assert_eq!(f.read(".git/config"), config);
    assert_eq!(f.snapshot(&modules), modules_before);
    fs::write(child.join("placeholder.txt"), b"not a child repository\n").unwrap();
    for kind in ["stage", "unstage"] {
        assert!(f
            .action(kind, json!({"files":[{"path":"module"}]}))
            .await
            .is_err());
    }

    let source = f.directory.path().join("child source 中文");
    let external = f.snapshot(&source);
    fs::write(
        child.join(".git"),
        format!("gitdir: {}\n", source.join(".git").display()),
    )
    .unwrap();
    let placeholder = f.snapshot(&child);
    for kind in ["stage", "unstage"] {
        assert!(f
            .action(kind, json!({"files":[{"path":"module"}]}))
            .await
            .is_err());
    }
    assert_eq!(f.snapshot(&source), external);
    assert_eq!(f.snapshot(&child), placeholder);
    assert_eq!(f.snapshot(&modules), modules_before);
    assert_eq!(f.read(".git/index"), index);
    assert_eq!(f.read(".git/config"), config);
}

#[tokio::test]
async fn gitlink_stage_and_unstage_preserve_expected_index_guard() {
    let f = Fixture::new();
    let (child, _) = f.submodule("module");
    f.advance_child(&child, b"child v1\n");
    for kind in ["stage", "unstage"] {
        if kind == "unstage" {
            f.action("stage", json!({"files":[{"path":"module"}]}))
                .await
                .unwrap();
        }
        let token = f.token().await;
        f.write("tracked.txt", format!("intervening {kind}\n").as_bytes());
        f.git(&["add", "--", "tracked.txt"]);
        let index = f.read(".git/index");
        let child_git = f.child_git_dir(&child);
        let child_before = f.snapshot(&child);
        let git_before = f.snapshot(&child_git);
        assert_eq!(
            f.action(
                kind,
                json!({"files":[{"path":"module"}],"expectedIndex":token})
            )
            .await
            .unwrap_err()
            .code,
            "STALE_INDEX"
        );
        assert_eq!(f.read(".git/index"), index);
        assert_eq!(f.snapshot(&child), child_before);
        assert_eq!(f.snapshot(&child_git), git_before);
    }
}

#[tokio::test]
async fn snapshot_fingerprint_binds_staged_blobs_with_identical_paths_and_xy_without_writes() {
    let f = Fixture::new();
    f.write("tracked.txt", b"staged version one\n");
    f.action("stage", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .unwrap();
    let v1 = f.git(&["rev-parse", ":tracked.txt"]);
    let before = f.snapshot(&f.path);
    let displayed = f.repository_snapshot().await;
    assert_eq!(f.snapshot(&f.path), before);
    assert_eq!(displayed.working.files.len(), 1);
    assert_eq!(displayed.working.files[0].path, "tracked.txt");
    assert_eq!(displayed.working.files[0].status, "M.");
    assert_eq!(
        f.repository_snapshot().await.fingerprint,
        displayed.fingerprint
    );

    f.write("tracked.txt", b"staged version two\n");
    f.action("stage", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .unwrap();
    let v2 = f.git(&["rev-parse", ":tracked.txt"]);
    assert_ne!(v1, v2);
    let before = f.snapshot(&f.path);
    let fresh = f.repository_snapshot().await;
    // Every pre-fix fingerprint input is equal; only the actual index differs.
    assert_eq!(
        serde_json::to_value(&displayed.repository).unwrap(),
        serde_json::to_value(&fresh.repository).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.working).unwrap(),
        serde_json::to_value(&fresh.working).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.refs).unwrap(),
        serde_json::to_value(&fresh.refs).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.stashes).unwrap(),
        serde_json::to_value(&fresh.stashes).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.remotes).unwrap(),
        serde_json::to_value(&fresh.remotes).unwrap()
    );
    assert_ne!(fresh.fingerprint, displayed.fingerprint);
    assert_eq!(f.snapshot(&f.path), before);
}

#[tokio::test]
async fn snapshot_fingerprint_binds_gitlink_oids_with_identical_paths_and_xy_without_writes() {
    let f = Fixture::new();
    let (child, _) = f.submodule("module");
    let v1 = f.advance_child(&child, b"child v1\n");
    f.action("stage", json!({"files":[{"path":"module"}]}))
        .await
        .unwrap();
    assert_eq!(f.git(&["rev-parse", ":module"]), v1);
    let before = f.snapshot(&f.path);
    let displayed = f.repository_snapshot().await;
    assert_eq!(f.snapshot(&f.path), before);
    assert_eq!(displayed.working.files.len(), 1);
    assert_eq!(displayed.working.files[0].path, "module");
    assert_eq!(displayed.working.files[0].status, "M.");

    let v2 = f.advance_child(&child, b"child v2\n");
    f.action("stage", json!({"files":[{"path":"module"}]}))
        .await
        .unwrap();
    assert_eq!(f.git(&["rev-parse", ":module"]), v2);
    assert_ne!(v1, v2);
    let before = f.snapshot(&f.path);
    let fresh = f.repository_snapshot().await;
    assert_eq!(
        serde_json::to_value(&displayed.repository).unwrap(),
        serde_json::to_value(&fresh.repository).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.working).unwrap(),
        serde_json::to_value(&fresh.working).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.refs).unwrap(),
        serde_json::to_value(&fresh.refs).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.stashes).unwrap(),
        serde_json::to_value(&fresh.stashes).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&displayed.remotes).unwrap(),
        serde_json::to_value(&fresh.remotes).unwrap()
    );
    assert_ne!(fresh.fingerprint, displayed.fingerprint);
    assert_eq!(f.snapshot(&f.path), before);
}

#[tokio::test]
async fn bare_snapshot_has_no_working_index_and_does_not_create_one() {
    let f = Fixture::new();
    let (bare, _) = f.remote();
    let git_dir = f.git_at(&bare, &["rev-parse", "--absolute-git-dir"]);
    let repo = Repository {
        id: "bare-snapshot-fixture".into(),
        path: bare.to_string_lossy().into_owned(),
        name: "Bare snapshot fixture".into(),
        git_dir: git_dir.clone(),
        common_dir: git_dir,
        head: None,
        branch: None,
        trusted: true,
        bare: true,
    };
    let before = f.snapshot(&bare);
    let request = "bare-snapshot";
    let _request = f.service.begin_request(request).unwrap();
    let _transaction = f
        .service
        .repository_transaction(&repo, request)
        .await
        .unwrap();
    let snapshot = f.service.snapshot(&repo, request).await.unwrap();
    assert!(snapshot.repository.bare);
    assert_eq!(snapshot.repository.head, Some(f.head()));
    assert!(snapshot.working.files.is_empty());
    assert!(!bare.join("index").exists());
    assert_eq!(f.snapshot(&bare), before);
}

#[tokio::test]
async fn ordinary_commit_requires_message_and_nonzero_staged_content_and_never_auto_adds() {
    let f = Fixture::new();
    let original = f.head();
    f.write("tracked.txt", b"unstaged only\n");
    assert_eq!(
        f.action("commit-staged", f.commit_options("zero").await)
            .await
            .unwrap_err()
            .code,
        "NOTHING_STAGED"
    );
    f.action("stage", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .unwrap();
    let mut empty = f.commit_options(" \n\t").await;
    assert!(f.action("commit-staged", empty.clone()).await.is_err());
    empty.as_object_mut().unwrap().remove("message");
    assert!(f.action("commit-staged", empty).await.is_err());
    f.write("tracked.txt", b"unstaged after confirmation\n");
    f.write("new.txt", b"do not add\n");
    f.action("commit-staged", f.commit_options("staged only").await)
        .await
        .unwrap();
    assert_ne!(f.head(), original);
    assert_eq!(f.git(&["show", "HEAD:tracked.txt"]), "unstaged only");
    assert_eq!(f.read("tracked.txt"), b"unstaged after confirmation\n");
    assert!(!f
        .output_at(&f.path, &["cat-file", "-e", "HEAD:new.txt"])
        .status
        .success());
    assert_eq!(f.git(&["remote"]), "");
}

#[tokio::test]
async fn commit_rejects_stale_head_index_and_missing_confirmation_including_unborn_null() {
    let f = Fixture::new();
    f.write("tracked.txt", b"first\n");
    f.action("stage", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .unwrap();
    let options = f.commit_options("reviewed").await;
    f.write("tracked.txt", b"later stage\n");
    f.git(&["add", "--", "tracked.txt"]);
    let head = f.head();
    assert_eq!(
        f.action("commit-staged", options).await.unwrap_err().code,
        "STALE_INDEX"
    );
    assert_eq!(f.head(), head);
    let options = f.commit_options("old head").await;
    f.git(&[
        "commit",
        "--quiet",
        "--allow-empty",
        "--message",
        "external advance",
    ]);
    assert_eq!(
        f.action("commit-staged", options).await.unwrap_err().code,
        "STALE_HEAD"
    );
    let mut missing = f.commit_options("missing head").await;
    missing.as_object_mut().unwrap().remove("expectedHead");
    assert_eq!(
        f.action("commit-staged", missing).await.unwrap_err().code,
        "CONFIRMATION_REQUIRED"
    );
    let unborn = Fixture::unborn();
    unborn.write("new.txt", b"new\n");
    unborn
        .action("stage", json!({"files":[{"path":"new.txt"}]}))
        .await
        .unwrap();
    let mut absent = unborn.commit_options("not confirmed null").await;
    absent.as_object_mut().unwrap().remove("expectedHead");
    assert_eq!(
        unborn
            .action("commit-staged", absent)
            .await
            .unwrap_err()
            .code,
        "CONFIRMATION_REQUIRED"
    );
    unborn
        .action(
            "commit-staged",
            unborn.commit_options("explicit null").await,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn index_token_is_readonly_and_observes_conflict_stages_and_intent_to_add() {
    let f = Fixture::new();
    let disk = fs::read(f.path.join(".git/index")).unwrap();
    let original = f.token().await;
    assert!(original.starts_with("index-v1:"));
    assert_eq!(fs::read(f.path.join(".git/index")).unwrap(), disk);
    f.write("new.txt", b"intent\n");
    f.git(&["add", "--intent-to-add", "--", "new.txt"]);
    assert_ne!(original, f.token().await);
    assert_eq!(
        f.action(
            "commit-staged",
            f.commit_options("intent is not content").await
        )
        .await
        .unwrap_err()
        .code,
        "NOTHING_STAGED"
    );
}

fn conflict(f: &Fixture) {
    f.git(&["switch", "--quiet", "--create", "other"]);
    f.write("tracked.txt", b"other side\n");
    f.commit("other");
    f.git(&["switch", "--quiet", "main"]);
    f.write("tracked.txt", b"local side\n");
    f.commit("local");
    assert!(!f
        .output_at(&f.path, &["merge", "--no-edit", "other"])
        .status
        .success());
}

#[tokio::test]
async fn conflicts_allow_explicit_stage_or_unstage_but_not_discard_or_ordinary_commit() {
    let f = Fixture::new();
    conflict(&f);
    let conflicted_token = f.token().await;
    assert_eq!(
        f.action(
            "discard",
            json!({"files":[{"path":"tracked.txt"}],"confirmation":"discard"})
        )
        .await
        .unwrap_err()
        .code,
        "UNRESOLVED_CONFLICTS"
    );
    assert_eq!(
        f.action("commit-staged", f.commit_options("bad").await)
            .await
            .unwrap_err()
            .code,
        "UNRESOLVED_CONFLICTS"
    );
    f.action("unstage", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .unwrap();
    assert!(f.git(&["ls-files", "--unmerged"]).is_empty());
    assert_ne!(conflicted_token, f.token().await);
    f.write("tracked.txt", b"resolved\n");
    f.action("stage", json!({"files":[{"path":"tracked.txt"}]}))
        .await
        .unwrap();
    assert_eq!(
        f.action("commit-staged", f.commit_options("use followup").await)
            .await
            .unwrap_err()
            .code,
        "OPERATION_IN_PROGRESS"
    );
    assert!(f.path.join(".git/MERGE_HEAD").exists());
    assert_eq!(f.index("tracked.txt"), "resolved");
}

#[tokio::test]
async fn squash_followup_semantics_are_not_consumed_by_ordinary_commit() {
    let f = Fixture::new();
    f.write("tracked.txt", b"squashed\n");
    f.git(&["add", "--", "tracked.txt"]);
    fs::write(f.path.join(".git/SQUASH_MSG"), b"original squash message\n").unwrap();
    assert_eq!(
        f.action("commit-staged", f.commit_options("not followup").await)
            .await
            .unwrap_err()
            .code,
        "FOLLOW_UP_REQUIRED"
    );
    assert_eq!(
        fs::read(f.path.join(".git/SQUASH_MSG")).unwrap(),
        b"original squash message\n"
    );
    assert_eq!(f.index("tracked.txt"), "squashed");
}

#[tokio::test]
async fn delete_untracked_requires_exact_confirmation_reclassifies_and_never_removes_directories() {
    let f = Fixture::new();
    f.write("delete[1].txt", b"delete me\n");
    f.write("delete1.txt", b"keep me\n");
    assert_eq!(
        f.action(
            "delete-untracked",
            json!({"files":[{"path":"delete[1].txt"}],"confirmation":"delete"})
        )
        .await
        .unwrap_err()
        .code,
        "CONFIRMATION_REQUIRED"
    );
    f.action(
        "delete-untracked",
        json!({"files":[{"path":"delete[1].txt","status":"?"}],"confirmation":"delete[1].txt"}),
    )
    .await
    .unwrap();
    assert!(!f.path.join("delete[1].txt").exists());
    assert_eq!(f.read("delete1.txt"), b"keep me\n");
    f.write("later-staged.txt", b"keep staged\n");
    f.git(&["add", "--", "later-staged.txt"]);
    assert!(f.action("delete-untracked", json!({"files":[{"path":"later-staged.txt","status":"?"}],"confirmation":"later-staged.txt"})).await.is_err());
    assert_eq!(f.read("later-staged.txt"), b"keep staged\n");
    fs::create_dir(f.path.join("dir")).unwrap();
    f.write("dir/child.txt", b"keep directory\n");
    for path in ["dir", ".git/config", "tracked.txt"] {
        assert!(f
            .action(
                "delete-untracked",
                json!({"files":[{"path":path}],"confirmation":path})
            )
            .await
            .is_err());
    }
    f.write(".gitignore", b"ignored.txt\n");
    f.write("ignored.txt", b"keep ignored\n");
    assert!(f
        .action(
            "delete-untracked",
            json!({"files":[{"path":"ignored.txt"}],"confirmation":"ignored.txt"})
        )
        .await
        .is_err());
    assert!(f.path.join("ignored.txt").exists());
    assert_eq!(f.read("dir/child.txt"), b"keep directory\n");
}

#[tokio::test]
async fn deletion_rejects_hard_links_and_nested_repositories_and_submodule_files() {
    let f = Fixture::new();
    let external = f.directory.path().join("outside.txt");
    fs::write(&external, b"precious\n").unwrap();
    fs::hard_link(&external, f.path.join("hardlink.txt")).unwrap();
    assert!(f
        .action(
            "delete-untracked",
            json!({"files":[{"path":"hardlink.txt"}],"confirmation":"hardlink.txt"})
        )
        .await
        .is_err());
    assert_eq!(fs::read(external).unwrap(), b"precious\n");
    let nested = f.path.join("nested");
    fs::create_dir(&nested).unwrap();
    f.git_at(
        &nested,
        &[
            "init",
            "--quiet",
            "--template",
            f.template.to_str().unwrap(),
        ],
    );
    f.write("nested/file.txt", b"nested precious\n");
    assert!(f
        .action(
            "delete-untracked",
            json!({"files":[{"path":"nested/file.txt"}],"confirmation":"nested/file.txt"})
        )
        .await
        .is_err());
    assert!(f
        .action("stage", json!({"files":[{"path":"nested"}]}))
        .await
        .is_err());
    f.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{},module", f.head()),
    ]);
    fs::create_dir(f.path.join("module")).unwrap();
    f.write("module/file.txt", b"module precious\n");
    assert!(f
        .action(
            "delete-untracked",
            json!({"files":[{"path":"module/file.txt"}],"confirmation":"module/file.txt"})
        )
        .await
        .is_err());
    assert!(f
        .action("unstage", json!({"files":[{"path":"module"}]}))
        .await
        .is_err());
    assert_eq!(f.read("module/file.txt"), b"module precious\n");
}

#[cfg(windows)]
#[tokio::test]
async fn deletion_rejects_junction_parent_without_symlink_privileges() {
    let f = Fixture::new();
    let outside = f.directory.path().join("junction outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("precious.txt"), b"preserve\n").unwrap();
    let junction = f.path.join("junction");
    // Fixture-only creation; production actions never execute shell commands.
    let status = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(f.action("delete-untracked", json!({"files":[{"path":"junction/precious.txt"}],"confirmation":"junction/precious.txt"})).await.is_err());
    assert_eq!(
        fs::read(outside.join("precious.txt")).unwrap(),
        b"preserve\n"
    );
    fs::remove_dir(junction).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn deletion_rejects_symlink_and_symlink_parent() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("precious.txt"), b"preserve\n").unwrap();
    symlink(outside.join("precious.txt"), f.path.join("link.txt")).unwrap();
    symlink(&outside, f.path.join("parent")).unwrap();
    for path in ["link.txt", "parent/precious.txt"] {
        assert!(f
            .action(
                "delete-untracked",
                json!({"files":[{"path":path}],"confirmation":path})
            )
            .await
            .is_err());
    }
    assert_eq!(
        fs::read(outside.join("precious.txt")).unwrap(),
        b"preserve\n"
    );
}

#[tokio::test]
async fn sync_uses_true_differently_named_upstream_and_pushes_only_after_pull() {
    let f = Fixture::new();
    let (bare, peer) = f.remote();
    f.write("local.txt", b"local new\n");
    f.commit("local ahead");
    fs::write(peer.join("remote.txt"), b"remote new\n").unwrap();
    f.git_at(&peer, &["add", "--", "remote.txt"]);
    f.git_at(&peer, &["commit", "--quiet", "--message", "remote ahead"]);
    f.git_at(&peer, &["push", "--quiet"]);
    let remote_before = f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]);
    f.action("sync", json!({"pullMode":"merge","sign":false}))
        .await
        .unwrap();
    assert_eq!(
        f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]),
        f.head()
    );
    assert_ne!(f.head(), remote_before);
    assert!(!f
        .output_at(&bare, &["show-ref", "--verify", "refs/heads/main"])
        .status
        .success());
    assert_eq!(f.read("remote.txt"), b"remote new\n");
    assert_eq!(f.read("local.txt"), b"local new\n");
    assert_eq!(
        f.git(&["config", "branch.main.merge"]),
        "refs/heads/remote-trunk"
    );
}

#[tokio::test]
async fn failed_or_conflicted_pull_never_pushes_and_preserves_recovery_state() {
    let f = Fixture::new();
    let (bare, peer) = f.remote();
    f.write("tracked.txt", b"local conflict\n");
    let local = f.commit("local conflict");
    fs::write(peer.join("tracked.txt"), b"remote conflict\n").unwrap();
    f.git_at(&peer, &["add", "--", "tracked.txt"]);
    f.git_at(
        &peer,
        &["commit", "--quiet", "--message", "remote conflict"],
    );
    f.git_at(&peer, &["push", "--quiet"]);
    let remote = f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]);
    f.hook(
        "pre-push",
        b"#!/bin/sh\nprintf attempted > .git/sync-push-attempted\nexit 1\n",
    );
    assert!(f
        .action("sync", json!({"pullMode":"ff-only"}))
        .await
        .is_err());
    assert_eq!(f.head(), local);
    assert_eq!(
        f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]),
        remote
    );
    assert!(f
        .action("sync", json!({"pullMode":"merge","sign":false}))
        .await
        .is_err());
    assert_eq!(f.head(), local);
    assert!(f.path.join(".git/MERGE_HEAD").exists());
    assert!(!f.git(&["ls-files", "--unmerged"]).is_empty());
    assert_eq!(
        f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]),
        remote
    );
    assert!(!f.path.join(".git/sync-push-attempted").exists());
}

#[tokio::test]
async fn sync_preflights_push_helper_and_never_guesses_origin_or_an_upstream() {
    let f = Fixture::new();
    assert_eq!(
        f.action("sync", json!({})).await.unwrap_err().code,
        "UPSTREAM_REQUIRED"
    );
    let (_, peer) = f.remote();
    fs::write(peer.join("remote.txt"), b"not fetched\n").unwrap();
    f.git_at(&peer, &["add", "--", "remote.txt"]);
    f.git_at(&peer, &["commit", "--quiet", "--message", "remote new"]);
    f.git_at(&peer, &["push", "--quiet"]);
    let before = f.head();
    let fetched_before = f.git(&["rev-parse", "refs/remotes/team.backup/remote-trunk"]);
    f.git(&["config", "remote.team.backup.pushurl", "ext::must-not-run"]);
    assert!(f.action("sync", json!({"pullMode":"merge"})).await.is_err());
    assert_eq!(f.head(), before);
    assert_eq!(
        f.git(&["rev-parse", "refs/remotes/team.backup/remote-trunk"]),
        fetched_before
    );
    assert!(!f.path.join("remote.txt").exists());
}

#[tokio::test]
async fn sync_rebase_replays_local_commits_onto_the_exact_upstream_before_push() {
    let f = Fixture::new();
    let (bare, peer) = f.remote();
    f.write("local.txt", b"local only\n");
    let old_local = f.commit("local commit");
    fs::write(peer.join("remote.txt"), b"remote only\n").unwrap();
    f.git_at(&peer, &["add", "--", "remote.txt"]);
    f.git_at(&peer, &["commit", "--quiet", "--message", "remote commit"]);
    f.git_at(&peer, &["push", "--quiet"]);
    let remote = f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]);
    f.action("sync", json!({"pullMode":"rebase","sign":false}))
        .await
        .unwrap();
    assert_ne!(f.head(), old_local);
    assert_eq!(f.git(&["rev-parse", "HEAD^1"]), remote);
    assert_eq!(
        f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]),
        f.head()
    );
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(f.read("local.txt"), b"local only\n");
    assert_eq!(f.read("remote.txt"), b"remote only\n");
}

#[tokio::test]
async fn cancellation_during_pull_integration_never_starts_push() {
    use std::time::Duration;
    let f = Fixture::new();
    let (bare, peer) = f.remote();
    fs::write(peer.join("remote.txt"), b"remote only\n").unwrap();
    f.git_at(&peer, &["add", "--", "remote.txt"]);
    f.git_at(&peer, &["commit", "--quiet", "--message", "remote commit"]);
    f.git_at(&peer, &["push", "--quiet"]);
    let remote = f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]);
    f.hook(
        "pre-push",
        b"#!/bin/sh\nprintf attempted > .git/sync-push-attempted\nexit 1\n",
    );
    f.hook(
        "post-merge",
        b"#!/bin/sh\nprintf entered > .git/sync-hook-entered\nwhile :; do sleep 1; done\n",
    );
    let action = f.action("sync", json!({"pullMode":"ff-only"}));
    let cancel = async {
        tokio::time::timeout(Duration::from_secs(30), async {
            while !f.path.join(".git/sync-hook-entered").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("pull must reach post-merge hook");
        f.service.cancel(REQUEST);
    };
    let (result, ()) = tokio::join!(action, cancel);
    assert_eq!(result.unwrap_err().code, "CANCELLED");
    assert!(f.service.active_processes(REQUEST).is_empty());
    assert!(!f.path.join(".git/sync-push-attempted").exists());
    assert_eq!(
        f.git_at(&bare, &["rev-parse", "refs/heads/remote-trunk"]),
        remote
    );
    assert!(!f
        .output_at(&bare, &["show-ref", "--verify", "refs/heads/main"])
        .status
        .success());
}

#[tokio::test]
async fn exact_case_and_space_boundaries_never_delete_a_different_file() {
    let f = Fixture::new();
    f.write("Case name.txt", b"case exact\n");
    f.write("Case name .txt", b"space exact\n");
    assert!(f
        .action(
            "delete-untracked",
            json!({"files":[{"path":"case name.txt"}],"confirmation":"case name.txt"})
        )
        .await
        .is_err());
    assert!(f
        .action(
            "delete-untracked",
            json!({"files":[{"path":"Case name.txt"}],"confirmation":"Case name .txt"})
        )
        .await
        .is_err());
    f.action(
        "delete-untracked",
        json!({"files":[{"path":"Case name .txt"}],"confirmation":"Case name .txt"}),
    )
    .await
    .unwrap();
    assert_eq!(f.read("Case name.txt"), b"case exact\n");
    assert!(!f.path.join("Case name .txt").exists());
}

#[tokio::test]
async fn precancelled_actions_and_untrusted_deletions_have_no_side_effects() {
    let mut f = Fixture::new();
    f.write("new.txt", b"preserve\n");
    f.service.cancel(REQUEST);
    assert_eq!(
        f.action("stage", json!({"files":[{"path":"new.txt"}]}))
            .await
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert!(f.git(&["diff", "--cached", "--name-only"]).is_empty());
    f.repo.trusted = false;
    assert_eq!(
        f.action(
            "delete-untracked",
            json!({"files":[{"path":"new.txt"}],"confirmation":"new.txt"})
        )
        .await
        .unwrap_err()
        .code,
        "UNTRUSTED"
    );
    assert_eq!(f.read("new.txt"), b"preserve\n");
}
