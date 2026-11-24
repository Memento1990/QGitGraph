//! Content-filter trust regressions. All Git commands, config, scripts and
//! sentinels belong to new temporary fixtures; no user repository/home is used.

use qgitgraph_lib::{
    error::Result,
    git::{sanitize_environment, GitService},
    model::{ComparisonQuery, DiffQuery, Repository},
};
use std::{
    fs::{self, FileTimes, OpenOptions},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, SystemTime},
};
use tempfile::TempDir;

const FILE: &str = "tracked.txt";

struct Fixture {
    root: TempDir,
    home: PathBuf,
    path: PathBuf,
    sentinel: PathBuf,
    filter_command: String,
    first: String,
    second: String,
    service: GitService,
    repo: Repository,
}

fn shell_quote(path: &std::path::Path) -> String {
    format!(
        "'{}'",
        path.to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\"'\"'")
    )
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("qgitgraph-untrusted-filters-")
            .tempdir()
            .unwrap();
        let home = root.path().join("isolated home");
        let path = root.path().join("worktree with spaces");
        let helpers = root.path().join("fixture scripts");
        for directory in [
            &home,
            &path,
            &helpers,
            &root.path().join("templates"),
            &root.path().join("hooks"),
        ] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let script = helpers.join("sentinel filter.sh");
        fs::write(&script, b"printf 'filter-ran\\n' >> \"$1\"\ncat\n").unwrap();
        let sentinel = root.path().join("filter sentinel");
        let filter_command = format!("sh {} {}", shell_quote(&script), shell_quote(&sentinel));
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "untrusted-filter-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "untrusted filter fixture".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: false,
            bare: false,
        };
        let mut fixture = Self {
            root,
            home,
            path,
            sentinel,
            filter_command,
            first: String::new(),
            second: String::new(),
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
            ("user.name", "Filter Fixture"),
            ("user.email", "filter@example.invalid"),
            ("core.autocrlf", "false"),
            ("core.filemode", "false"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            (
                "core.hooksPath",
                fixture.root.path().join("hooks").to_str().unwrap(),
            ),
        ] {
            fixture.git(&["config", "--local", key, value]);
        }
        fs::write(
            fixture.path.join(".gitattributes"),
            b"tracked.txt filter=guard\n",
        )
        .unwrap();
        fixture.write_tracked(b"first\n", 1_704_067_200);
        fixture.first = fixture.commit("first");
        fixture.write_tracked(b"index\n", 1_704_067_260);
        fixture.second = fixture.commit("second");
        fixture.repo.head = Some(fixture.second.clone());
        // Same byte length as the index, but a distinct mtime: status must hash
        // the worktree contents rather than detect a size-only modification.
        fixture.write_tracked(b"local\n", 1_704_067_320);
        assert_eq!(fs::metadata(fixture.path.join(FILE)).unwrap().len(), 6);
        fixture
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.path, args)
    }

    fn git_at(&self, path: &std::path::Path, args: &[&str]) -> String {
        let mut command = Command::new(self.service.git_path());
        sanitize_environment(&mut command, true, false, Some(&self.home));
        let output = command
            .current_dir(path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .env("GIT_PAGER", "cat")
            .args(["--no-pager", "-c", "core.fsmonitor=false"])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture Git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    fn add_submodule(&self, parent: &std::path::Path, name: &str, source_name: &str) -> PathBuf {
        let source = self.root.path().join(source_name);
        fs::create_dir(&source).unwrap();
        self.git_at(
            &source,
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                "--template",
                self.root.path().join("templates").to_str().unwrap(),
            ],
        );
        for (key, value) in [
            ("user.name", "Child Filter Fixture"),
            ("user.email", "child@example.invalid"),
            ("core.autocrlf", "false"),
            ("commit.gpgsign", "false"),
        ] {
            self.git_at(&source, &["config", key, value]);
        }
        fs::write(source.join(".gitattributes"), b"tracked.txt filter=guard\n").unwrap();
        fs::write(source.join(FILE), b"child base\n").unwrap();
        self.git_at(&source, &["add", "--all"]);
        self.git_at(&source, &["commit", "--quiet", "--message=fixture"]);
        self.git_at(
            parent,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                "--",
                source.to_str().unwrap(),
                name,
            ],
        );
        self.git_at(
            parent,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "--message=module",
            ],
        );
        let child = parent.join(name);
        self.git_at(&child, &["config", "core.autocrlf", "false"]);
        child
    }

    fn child_filter(&self, path: &std::path::Path, knob: &str) {
        self.git_at(
            path,
            &[
                "config",
                &format!("filter.guard.{knob}"),
                &self.filter_command,
            ],
        );
        let tracked = path.join(FILE);
        fs::write(&tracked, b"child edit\n").unwrap();
        OpenOptions::new()
            .write(true)
            .open(tracked)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_704_067_320)),
            )
            .unwrap();
    }

    fn write_tracked(&self, bytes: &[u8], timestamp: u64) {
        let path = self.path.join(FILE);
        fs::write(&path, bytes).unwrap();
        OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(timestamp)),
            )
            .unwrap();
    }

    fn commit(&self, message: &str) -> String {
        self.git(&["add", "--all", "--", "."]);
        self.git(&["commit", "--quiet", "--no-gpg-sign", "--message", message]);
        self.git(&["rev-parse", "HEAD"])
    }

    fn clean_filter(&self) {
        self.git(&[
            "config",
            "--local",
            "filter.guard.clean",
            &self.filter_command,
        ]);
    }

    fn query(&self, id: &str, base: Option<&str>, target: &str) -> DiffQuery {
        DiffQuery {
            repo_id: self.repo.id.clone(),
            request_id: id.into(),
            base: base.map(str::to_owned),
            target: target.into(),
            path: FILE.into(),
            old_path: None,
            context: Some(3),
            encoding: None,
            staged: None,
        }
    }

    fn comparison(&self, id: &str, base: Option<&str>, target: &str) -> ComparisonQuery {
        ComparisonQuery {
            repo_id: self.repo.id.clone(),
            request_id: id.into(),
            base: base.map(str::to_owned),
            target: target.into(),
        }
    }

    fn blocked<T: std::fmt::Debug>(&self, result: Result<T>) {
        let error = result.expect_err("an untrusted filtered read must fail explicitly");
        assert_eq!(error.code, "UNTRUSTED_FILTER", "{error:?}");
        assert!(error.message.contains("Trust"));
        assert!(!self.sentinel.exists(), "the filter must not execute");
    }

    fn ran_filter(&self) {
        // Git may rehash a tracked path more than once during status/diff.
        let sentinel = fs::read_to_string(&self.sentinel).unwrap();
        assert!(!sentinel.is_empty());
        assert!(sentinel.lines().all(|line| line == "filter-ran"));
        fs::remove_file(&self.sentinel).unwrap();
    }
}

#[tokio::test]
async fn untrusted_status_and_snapshot_fail_explicitly_without_running_clean() {
    let f = Fixture::new();
    f.clean_filter();
    let index = fs::read(f.path.join(".git/index")).unwrap();
    f.blocked(f.service.working_state(&f.repo, "blocked-status").await);
    f.blocked(f.service.snapshot(&f.repo, "blocked-snapshot").await);
    assert_eq!(fs::read(f.path.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(f.path.join(FILE)).unwrap(), b"local\n");
}

#[tokio::test]
async fn untrusted_worktree_and_index_to_worktree_diffs_never_run_clean() {
    let f = Fixture::new();
    f.clean_filter();
    for base in [None, Some("INDEX")] {
        f.blocked(
            f.service
                .compare(&f.repo, f.comparison("blocked-compare", base, "WORKTREE"))
                .await,
        );
        f.blocked(
            f.service
                .diff_patch(&f.repo, f.query("blocked-patch", base, "WORKTREE"))
                .await,
        );
        f.blocked(
            f.service
                .diff(&f.repo, f.query("blocked-diff", base, "WORKTREE"))
                .await,
        );
    }
}

#[tokio::test]
async fn trusted_status_and_worktree_diffs_keep_existing_filter_semantics() {
    let f = Fixture::new();
    f.clean_filter();
    let mut trusted = f.repo.clone();
    trusted.trusted = true;
    let state = f
        .service
        .working_state(&trusted, "trusted-status")
        .await
        .unwrap();
    assert!(state
        .files
        .iter()
        .any(|file| file.path == FILE && file.unstaged));
    f.ran_filter();
    for base in [None, Some("INDEX")] {
        let patch = f
            .service
            .diff_patch(&trusted, f.query("trusted-patch", base, "WORKTREE"))
            .await
            .unwrap();
        assert!(patch.patch.contains("-index\n") && patch.patch.contains("+local\n"));
        f.ran_filter();
        let diff = f
            .service
            .diff(&trusted, f.query("trusted-diff", base, "WORKTREE"))
            .await
            .unwrap();
        assert_eq!(diff.new_content.as_deref(), Some("local\n"));
        f.ran_filter();
    }
}

#[tokio::test]
async fn historical_index_and_raw_content_reads_remain_available_with_filters() {
    let f = Fixture::new();
    f.clean_filter();
    for target in [&*f.second, "INDEX"] {
        let comparison = f
            .service
            .compare(
                &f.repo,
                f.comparison("object-compare", Some(&f.first), target),
            )
            .await
            .unwrap();
        assert!(comparison.iter().any(|file| file.path == FILE));
        let query = f.query("object-diff", Some(&f.first), target);
        let patch = f.service.diff_patch(&f.repo, query.clone()).await.unwrap();
        assert!(patch.patch.contains("-first\n") && patch.patch.contains("+index\n"));
        let diff = f.service.diff(&f.repo, query.clone()).await.unwrap();
        assert_eq!(diff.old_content.as_deref(), Some("first\n"));
        assert_eq!(diff.new_content.as_deref(), Some("index\n"));
        let content = f.service.content_side(&f.repo, query, "new").await.unwrap();
        assert_eq!(content.new_content.as_deref(), Some("index\n"));
    }
    // Raw content_side reads bytes itself, without asking Git to convert them.
    let content = f
        .service
        .content_side(
            &f.repo,
            f.query("raw-worktree", Some("INDEX"), "WORKTREE"),
            "new",
        )
        .await
        .unwrap();
    assert_eq!(content.new_content.as_deref(), Some("local\n"));
    assert!(!f.sentinel.exists());
}

#[tokio::test]
async fn all_filter_knobs_and_effective_global_and_included_config_are_checked() {
    for knob in ["clean", "smudge", "process", "required"] {
        let f = Fixture::new();
        f.git(&[
            "config",
            "--local",
            &format!("filter.guard.{knob}"),
            if knob == "required" {
                "false"
            } else {
                &f.filter_command
            },
        ]);
        f.blocked(f.service.working_state(&f.repo, "filter-knob").await);
    }
    for included in [false, true] {
        let f = Fixture::new();
        let config = if included {
            f.home.join("included config")
        } else {
            f.home.join(".gitconfig")
        };
        f.git(&[
            "config",
            "--file",
            config.to_str().unwrap(),
            "filter.guard.clean",
            &f.filter_command,
        ]);
        if included {
            f.git(&[
                "config",
                "--local",
                "include.path",
                config.to_str().unwrap(),
            ]);
        }
        f.blocked(
            f.service
                .working_state(&f.repo, "effective-filter-config")
                .await,
        );
        f.blocked(
            f.service
                .diff_patch(
                    &f.repo,
                    f.query("effective-filter-diff", Some("INDEX"), "WORKTREE"),
                )
                .await,
        );
    }
}

#[tokio::test]
async fn parent_status_snapshot_and_worktree_diffs_never_execute_untrusted_child_filters() {
    for trusted in [false, true] {
        for knob in ["clean", "process"] {
            let f = Fixture::new();
            let child = f.add_submodule(&f.path, "module", "child source");
            f.child_filter(&child, knob);
            let mut parent = f.repo.clone();
            parent.trusted = trusted;
            let parent_index = fs::read(f.path.join(".git/index")).unwrap();
            let child_git = f.git_at(&child, &["rev-parse", "--absolute-git-dir"]);
            let child_index = fs::read(PathBuf::from(&child_git).join("index")).unwrap();
            f.blocked(
                f.service
                    .working_state(&parent, "child-filter-parent-status")
                    .await,
            );
            f.blocked(
                f.service
                    .snapshot(&parent, "child-filter-parent-snapshot")
                    .await,
            );
            f.blocked(
                f.service
                    .submodules(&parent, "child-filter-submodules")
                    .await,
            );
            f.blocked(
                f.service
                    .compare(
                        &parent,
                        f.comparison("child-filter-compare", Some("INDEX"), "WORKTREE"),
                    )
                    .await,
            );
            f.blocked(
                f.service
                    .diff_patch(
                        &parent,
                        f.query("child-filter-patch", Some("INDEX"), "WORKTREE"),
                    )
                    .await,
            );
            f.blocked(
                f.service
                    .diff(
                        &parent,
                        f.query("child-filter-diff", Some("INDEX"), "WORKTREE"),
                    )
                    .await,
            );
            if trusted {
                let action = serde_json::from_value(serde_json::json!({
                    "repoId":parent.id,"requestId":"child-filter-action-preflight","kind":"rebase","target":f.second
                })).unwrap();
                f.blocked(f.service.action(&parent, action).await);
            }
            assert_eq!(fs::read(f.path.join(".git/index")).unwrap(), parent_index);
            assert_eq!(
                fs::read(PathBuf::from(child_git).join("index")).unwrap(),
                child_index
            );
            assert!(!f.sentinel.exists());
        }
    }
}

#[tokio::test]
async fn parent_reads_never_execute_grandchild_clean_or_process_filters() {
    for knob in ["clean", "process"] {
        let f = Fixture::new();
        let child = f.add_submodule(&f.path, "module", "child source");
        let grandchild = f.add_submodule(&child, "nested", "grandchild source");
        f.child_filter(&grandchild, knob);
        let mut parent = f.repo.clone();
        parent.trusted = true;
        f.blocked(
            f.service
                .working_state(&parent, "grandchild-filter-status")
                .await,
        );
        f.blocked(
            f.service
                .diff_patch(
                    &parent,
                    f.query("grandchild-filter-patch", Some("INDEX"), "WORKTREE"),
                )
                .await,
        );
        assert!(!f.sentinel.exists());
    }
}

#[tokio::test]
async fn safe_parent_status_keeps_exact_gitlink_dirty_and_untracked_information() {
    let f = Fixture::new();
    let child = f.add_submodule(&f.path, "module", "child source");
    let parent_index_content = f.git(&["show", ":tracked.txt"]);
    f.write_tracked(b"parent edit\n", 1_704_067_380);
    fs::write(child.join(FILE), b"dirty child\n").unwrap();
    fs::write(child.join("untracked.txt"), b"private child content\n").unwrap();
    let state = f
        .service
        .working_state(&f.repo, "safe-child-dirty")
        .await
        .unwrap();
    let module = state
        .files
        .iter()
        .find(|file| file.path == "module")
        .unwrap();
    let flags = module.submodule.as_ref().unwrap();
    assert!(!flags.commit_changed);
    assert!(flags.modified && flags.untracked && module.unstaged);
    assert!(!state
        .files
        .iter()
        .any(|file| file.path.starts_with("module/")));
    let patch = f
        .service
        .diff_patch(
            &f.repo,
            f.query("dirty-child-unrelated-file", Some("INDEX"), "WORKTREE"),
        )
        .await
        .unwrap();
    assert!(patch.patch.contains(&format!("-{parent_index_content}\n")));
    assert!(patch.patch.contains("+parent edit\n"));
    let mut query = f.query("dirty-child-patch", Some("INDEX"), "WORKTREE");
    query.path = "module".into();
    let error = f.service.diff_patch(&f.repo, query).await.unwrap_err();
    assert_eq!(error.code, "SUBMODULE_DIRTY");
    assert!(!f.sentinel.exists());
}

#[tokio::test]
async fn no_matching_filter_config_keeps_untrusted_status_and_diffs_accurate() {
    let f = Fixture::new();
    let state = f
        .service
        .working_state(&f.repo, "no-filter-status")
        .await
        .unwrap();
    assert!(state
        .files
        .iter()
        .any(|file| file.path == FILE && file.unstaged));
    let files = f
        .service
        .compare(
            &f.repo,
            f.comparison("no-filter-compare", Some("INDEX"), "WORKTREE"),
        )
        .await
        .unwrap();
    assert!(files.iter().any(|file| file.path == FILE));
    let query = f.query("no-filter-diff", Some("INDEX"), "WORKTREE");
    let patch = f.service.diff_patch(&f.repo, query.clone()).await.unwrap();
    assert!(patch.patch.contains("-index\n") && patch.patch.contains("+local\n"));
    let diff = f.service.diff(&f.repo, query).await.unwrap();
    assert_eq!(diff.old_content.as_deref(), Some("index\n"));
    assert_eq!(diff.new_content.as_deref(), Some("local\n"));
    assert!(!f.sentinel.exists());
}
