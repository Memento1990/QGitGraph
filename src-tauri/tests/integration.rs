//! Public-API integration tests against repositories created only in TempDir.
//! Git configuration is isolated per child process; these tests never change the
//! runner's environment, the user's identity, or contact a network remote.

use qgitgraph_lib::{
    error::Result,
    git::GitService,
    model::{
        ActionResult, ChangedFile, ComparisonQuery, DiffQuery, GitAction, HistoryQuery, Repository,
    },
};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

const REQUEST: &str = "integration-request";
const TRACKED: &str = "tracked 中文.txt";
const OLD_NAME: &str = "old name 中文.txt";
const NEW_NAME: &str = "renamed 文件.txt";
const ORIGINAL_RENAME: &str = "one\ntwo\nthree\nfour\nfive\n";
const ORIGINAL_BINARY: &[u8] = &[0, 1, 2, 255, 10, 0, 42];

struct Fixture {
    directory: TempDir,
    home: PathBuf,
    path: PathBuf,
    service: GitService,
    repo: Repository,
    clock: Cell<u64>,
}

impl Fixture {
    fn empty() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-integration-")
            .tempdir()
            .expect("create isolated fixture directory");
        let home = directory.path().join("隔离 Home");
        let path = directory.path().join("仓库 with 空格");
        for child in [
            &home,
            &path,
            &directory.path().join("empty templates"),
            &directory.path().join("empty hooks"),
        ] {
            fs::create_dir_all(child).expect("create fixture directory");
        }
        fs::write(home.join(".gitconfig"), b"").expect("create empty isolated Git config");
        fs::write(home.join("attributes"), b"").expect("create isolated attributes");
        fs::write(home.join("ignore"), b"").expect("create isolated ignore file");
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "临时仓库 with 空格".into(),
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
            service,
            repo,
            clock: Cell::new(1_704_067_200), // 2024-01-01 UTC.
        };
        let templates = fixture.directory.path().join("empty templates");
        fixture.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--template",
            templates.to_str().expect("UTF-8 temporary path"),
        ]);
        fixture.configure_at(&fixture.path);
        fixture
    }

    fn seeded() -> Self {
        let fixture = Self::empty();
        fixture.write(TRACKED, b"base\n");
        fixture.write(OLD_NAME, ORIGINAL_RENAME.as_bytes());
        fixture.write("delete me.txt", b"remove me\n");
        fixture.write("empty.txt", b"");
        fixture.write("binary.bin", ORIGINAL_BINARY);
        fixture.write("-literal.txt", b"dash path\n");
        fixture.write("literal[1].txt", b"bracket path\n");
        fixture.write("literal1.txt", b"different literal path\n");
        fixture.commit_all("root 中文");
        fixture
    }

    fn command_at(&self, directory: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(self.service.git_path());
        command.current_dir(directory);
        // Remove inherited Git routing, author, config-count, helper and index
        // overrides without mutating process-global environment in parallel tests.
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
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join("xdg"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .env("GIT_PAGER", "cat")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "false")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .args([
                "--no-pager",
                "-c",
                "color.ui=false",
                "-c",
                "core.quotepath=false",
                "-c",
                "core.autocrlf=false",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "tag.gpgsign=false",
            ])
            .arg("-c")
            .arg(format!(
                "core.hooksPath={}",
                self.directory.path().join("empty hooks").display()
            ))
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn output_at(&self, directory: &Path, args: &[&str]) -> Output {
        self.command_at(directory, args)
            .output()
            .unwrap_or_else(|error| panic!("start fixture Git {args:?}: {error}"))
    }

    fn git_at(&self, directory: &Path, args: &[&str]) -> String {
        let output = self.output_at(directory, args);
        assert!(
            output.status.success(),
            "fixture Git {args:?} in {} failed: {}\n{}",
            directory.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        String::from_utf8(output.stdout).expect("fixture Git text is UTF-8")
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.path, args)
    }

    fn git_input(&self, args: &[&str], input: &[u8]) -> String {
        let mut command = self.command_at(&self.path, args);
        command.stdin(Stdio::piped());
        let mut child = command
            .spawn()
            .expect("start Git with fixture object input");
        child
            .stdin
            .take()
            .expect("Git input pipe")
            .write_all(input)
            .expect("write fixture object");
        let output = child
            .wait_with_output()
            .expect("wait for fixture object Git");
        assert!(
            output.status.success(),
            "Git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("object ID is UTF-8")
            .trim()
            .to_owned()
    }

    fn configure_at(&self, path: &Path) {
        for (key, value) in [
            ("user.name", "测试 Author"),
            ("user.email", "author@example.test"),
            ("core.autocrlf", "false"),
            ("core.safecrlf", "false"),
            ("core.filemode", "false"),
            ("core.logAllRefUpdates", "true"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("credential.helper", ""),
            ("protocol.file.allow", "always"),
            ("status.renames", "true"),
            ("diff.renames", "true"),
        ] {
            self.git_at(path, &["config", "--local", key, value]);
        }
        for (key, value) in [
            ("core.hooksPath", self.directory.path().join("empty hooks")),
            ("core.attributesFile", self.home.join("attributes")),
            ("core.excludesFile", self.home.join("ignore")),
        ] {
            self.git_at(
                path,
                &[
                    "config",
                    "--local",
                    key,
                    value.to_str().expect("UTF-8 path"),
                ],
            );
        }
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.path.join(relative);
        fs::create_dir_all(path.parent().expect("fixture file parent"))
            .expect("create file parent");
        fs::write(path, bytes).expect("write fixture file");
    }

    fn commit_all(&self, message: &str) -> String {
        self.git(&["add", "--all", "--", "."]);
        self.commit_index_at(&self.path, message)
    }

    fn commit_index_at(&self, path: &Path, message: &str) -> String {
        self.clock.set(self.clock.get() + 60);
        self.git_at(
            path,
            &["commit", "--quiet", "--no-gpg-sign", "--message", message],
        );
        self.git_at(path, &["rev-parse", "HEAD"]).trim().to_owned()
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }

    fn ref_exists(&self, full_name: &str) -> bool {
        self.git(&["for-each-ref", "--format=%(refname)", "--", full_name])
            .lines()
            .any(|line| line == full_name)
    }

    fn bare(&self, name: &str) -> PathBuf {
        let path = self.directory.path().join(name);
        fs::create_dir(&path).expect("create a new empty bare repository directory");
        let templates = self.directory.path().join("empty templates");
        self.git_at(
            &path,
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                "--template",
                templates.to_str().expect("UTF-8 template path"),
            ],
        );
        self.configure_at(&path);
        path
    }

    fn clone_local(&self, source: &Path, name: &str) -> PathBuf {
        let destination = self.directory.path().join(name);
        self.git_at(
            self.directory.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "clone",
                "--quiet",
                "--no-hardlinks",
                "--",
                source.to_str().expect("UTF-8 source path"),
                destination.to_str().expect("UTF-8 clone path"),
            ],
        );
        self.configure_at(&destination);
        destination
    }
}

fn history_query(repo: &Repository, overrides: Value) -> HistoryQuery {
    let mut value = json!({
        "repoId": repo.id,
        "requestId": REQUEST,
        "offset": 0,
        "limit": 100,
        "revision": null,
        "search": null,
        "searchMode": "all",
        "order": "topo",
        "firstParent": false,
        "includeReflog": false,
        "showRemotes": true,
        "showTags": true,
        "showStashes": false,
        "mailmap": true
    });
    value.as_object_mut().unwrap().extend(
        overrides
            .as_object()
            .expect("history overrides object")
            .clone(),
    );
    serde_json::from_value(value).expect("valid history fixture query")
}

fn comparison(repo: &Repository, base: Option<&str>, target: &str) -> ComparisonQuery {
    ComparisonQuery {
        repo_id: repo.id.clone(),
        request_id: REQUEST.into(),
        base: base.map(str::to_owned),
        target: target.into(),
    }
}

fn diff_query(
    repo: &Repository,
    base: Option<&str>,
    target: &str,
    path: &str,
    old_path: Option<&str>,
) -> DiffQuery {
    DiffQuery {
        repo_id: repo.id.clone(),
        request_id: REQUEST.into(),
        base: base.map(str::to_owned),
        target: target.into(),
        path: path.into(),
        old_path: old_path.map(str::to_owned),
        context: Some(3),
        encoding: Some("utf-8".into()),
        staged: None,
    }
}

fn action(repo: &Repository, kind: &str, fields: Value) -> GitAction {
    let mut value = json!({"repoId": repo.id, "requestId": REQUEST, "kind": kind});
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().expect("action fields object").clone());
    serde_json::from_value(value).expect("valid action fixture envelope")
}

async fn perform(
    service: &GitService,
    repo: &Repository,
    kind: &str,
    fields: Value,
) -> Result<ActionResult> {
    // Mirror the IPC transaction boundary, rather than relying on Git's locks
    // to serialize the multiple subprocesses in an action.
    let _transaction = service.transaction(&repo.id).await;
    service.action(repo, action(repo, kind, fields)).await
}

fn file<'a>(files: &'a [ChangedFile], path: &str) -> &'a ChangedFile {
    files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("missing {path:?} in {files:#?}"))
}

fn paths(files: &[ChangedFile]) -> BTreeSet<&str> {
    files.iter().map(|file| file.path.as_str()).collect()
}

struct Graph {
    root: String,
    main: String,
    topic: String,
    merge: String,
}

fn merged_graph(fixture: &Fixture) -> Graph {
    let root = fixture.head();
    fixture.git(&["branch", "topic", &root]);
    fixture.write("main only.txt", b"main side\n");
    let main = fixture.commit_all("main side");
    fixture.git(&["switch", "--quiet", "topic"]);
    fixture.write("topic only.txt", b"topic side\n");
    let topic = fixture.commit_all("topic [literal].*\n\nbody-only-needle\n第二段正文");
    fixture.git(&["switch", "--quiet", "main"]);
    fixture.clock.set(fixture.clock.get() + 60);
    fixture.git(&[
        "merge",
        "--quiet",
        "--no-ff",
        "--no-edit",
        "--message",
        "merge 中文",
        "topic",
    ]);
    Graph {
        root,
        main,
        topic,
        merge: fixture.head(),
    }
}

#[tokio::test]
async fn runner_preserves_raw_bytes_and_git_failures() {
    let fixture = Fixture::seeded();
    let service = &fixture.service;
    let request = service.begin_request(REQUEST).unwrap();
    assert!(service.begin_request(REQUEST).is_err());
    for invalid in [String::new(), "control\nrequest".into(), "a".repeat(129)] {
        assert!(service.begin_request(&invalid).is_err());
    }
    let root = fixture.head();
    let output = service
        .run(
            &fixture.repo,
            REQUEST,
            vec!["rev-parse".into(), "--show-toplevel".into()],
            false,
        )
        .await
        .unwrap();
    assert_eq!(
        fs::canonicalize(output.trim()).unwrap(),
        fs::canonicalize(&fixture.path).unwrap()
    );
    let bytes = service
        .run_bytes(
            &fixture.repo,
            REQUEST,
            vec![
                "cat-file".into(),
                "blob".into(),
                format!("{root}:binary.bin"),
            ],
            false,
        )
        .await
        .unwrap();
    assert_eq!(bytes, ORIGINAL_BINARY);
    let error = service
        .run(
            &fixture.repo,
            REQUEST,
            vec![
                "rev-parse".into(),
                "--verify".into(),
                "refs/heads/missing".into(),
            ],
            false,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "GIT");
    assert!(!error.detail.unwrap_or_default().trim().is_empty());
    let error = service
        .run(
            &fixture.repo,
            REQUEST,
            vec!["status\0injected".into()],
            false,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "ARGUMENT");
    drop(request);
    let _replacement = service
        .begin_request(REQUEST)
        .expect("RAII unregisters completed request IDs");
    assert_eq!(
        service
            .run(
                &fixture.repo,
                REQUEST,
                vec!["rev-parse".into(), "HEAD".into()],
                false
            )
            .await
            .unwrap()
            .trim(),
        root
    );
}

#[tokio::test]
async fn pre_cancelled_requests_cannot_spawn_and_cancellation_does_not_leak_after_drop() {
    let fixture = Fixture::empty();
    let service = &fixture.service;
    let request = service.begin_request(REQUEST).unwrap();
    service.cancel(REQUEST);
    let error = service
        .run(&fixture.repo, REQUEST, vec!["--version".into()], false)
        .await
        .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    drop(request);
    let _fresh_request = service.begin_request(REQUEST).unwrap();
    assert!(service
        .run(&fixture.repo, REQUEST, vec!["--version".into()], false)
        .await
        .unwrap()
        .starts_with("git version "));
    let _other_request = service.begin_request("other-request").unwrap();
    service.cancel_all();
    for id in [REQUEST, "other-request"] {
        assert_eq!(
            service
                .run(&fixture.repo, id, vec!["--version".into()], false)
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
    }
}

#[tokio::test]
async fn history_reads_merge_graph_pagination_search_and_ref_decorations() {
    let fixture = Fixture::seeded();
    let graph = merged_graph(&fixture);
    fixture.git(&["tag", "root-tag", &graph.root]);
    fixture.git(&[
        "tag",
        "--annotate",
        "发布-v1",
        "--message",
        "annotated 中文",
        &graph.merge,
    ]);
    fixture.git(&["update-ref", "refs/remotes/local/main", &graph.merge]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let refs = fixture.service.refs(&fixture.repo, REQUEST).await.unwrap();
    let main = refs
        .iter()
        .find(|item| item.full_name == "refs/heads/main")
        .unwrap();
    assert!(main.current);
    assert_eq!(main.oid, graph.merge);
    assert!(refs.iter().any(|item| item.full_name == "refs/tags/发布-v1"
        && item.oid == graph.merge
        && item.kind == "tag"));
    assert!(refs
        .iter()
        .any(|item| item.full_name == "refs/remotes/local/main" && item.kind == "remote"));
    let full = fixture
        .service
        .history(&fixture.repo, history_query(&fixture.repo, json!({})))
        .await
        .unwrap();
    assert!(!full.has_more);
    assert_eq!(full.commits.len(), 4);
    assert_eq!(full.commits[0].oid, graph.merge);
    assert_eq!(
        full.commits[0].parents,
        vec![graph.main.clone(), graph.topic.clone()]
    );
    assert!(full
        .commits
        .iter()
        .find(|commit| commit.oid == graph.root)
        .unwrap()
        .parents
        .is_empty());
    assert!(full.commits[0]
        .refs
        .iter()
        .any(|item| item.name == "发布-v1"));
    let first = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"limit": 2})),
        )
        .await
        .unwrap();
    let second = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"offset": 2, "limit": 2})),
        )
        .await
        .unwrap();
    assert!(first.has_more);
    assert!(!second.has_more);
    let paged: Vec<_> = first
        .commits
        .iter()
        .chain(&second.commits)
        .map(|commit| &commit.oid)
        .collect();
    assert_eq!(
        paged,
        full.commits
            .iter()
            .map(|commit| &commit.oid)
            .collect::<Vec<_>>()
    );
    let beyond = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"offset": 99})),
        )
        .await
        .unwrap();
    assert!(beyond.commits.is_empty() && !beyond.has_more);
    let first_parent = fixture
        .service
        .history(
            &fixture.repo,
            history_query(
                &fixture.repo,
                json!({"revision": "refs/heads/main", "firstParent": true}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        first_parent
            .commits
            .iter()
            .map(|commit| commit.oid.as_str())
            .collect::<Vec<_>>(),
        vec![
            graph.merge.as_str(),
            graph.main.as_str(),
            graph.root.as_str()
        ]
    );
    for (mode, needle, expected) in [
        ("message", "[literal].*", graph.topic.as_str()),
        ("all", "body-only-needle", graph.topic.as_str()),
        ("hash", &graph.merge[..12], graph.merge.as_str()),
    ] {
        let found = fixture
            .service
            .history(
                &fixture.repo,
                history_query(&fixture.repo, json!({"searchMode": mode, "search": needle})),
            )
            .await
            .unwrap();
        assert_eq!(found.commits.len(), 1, "search mode {mode}");
        assert_eq!(found.commits[0].oid, expected);
    }
    for options in [
        json!({"searchMode": "author", "search": "author@example.test"}),
        json!({"searchMode": "date", "search": "2024-01-01"}),
    ] {
        assert_eq!(
            fixture
                .service
                .history(&fixture.repo, history_query(&fixture.repo, options))
                .await
                .unwrap()
                .commits
                .len(),
            4
        );
    }
    let hidden = fixture
        .service
        .history(
            &fixture.repo,
            history_query(
                &fixture.repo,
                json!({"showTags": false, "showRemotes": false}),
            ),
        )
        .await
        .unwrap();
    assert!(hidden
        .commits
        .iter()
        .flat_map(|commit| &commit.refs)
        .all(|item| item.kind != "tag" && item.kind != "remote"));
}

#[tokio::test]
async fn history_visibility_and_reflog_are_explicit_and_stashes_keep_selectors() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    fixture.write("lost commit.txt", b"reachable only through reflog\n");
    let lost = fixture.commit_all("reflog-only");
    fixture.git(&["reset", "--hard", &root]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let normal = fixture
        .service
        .history(&fixture.repo, history_query(&fixture.repo, json!({})))
        .await
        .unwrap();
    assert!(!normal.commits.iter().any(|commit| commit.oid == lost));
    let reflog = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"includeReflog": true})),
        )
        .await
        .unwrap();
    assert!(reflog.commits.iter().any(|commit| commit.oid == lost));
    fixture.git(&["tag", "lost-tag", &lost]);
    let tagged = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"showTags": true})),
        )
        .await
        .unwrap();
    assert!(tagged.commits.iter().any(|commit| commit.oid == lost));
    let hidden_tag = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"showTags": false})),
        )
        .await
        .unwrap();
    assert!(!hidden_tag.commits.iter().any(|commit| commit.oid == lost));
    fixture.git(&["tag", "--delete", "lost-tag"]);
    fixture.git(&["update-ref", "refs/remotes/local/lost", &lost]);
    let hidden_remote = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"showRemotes": false})),
        )
        .await
        .unwrap();
    assert!(!hidden_remote
        .commits
        .iter()
        .any(|commit| commit.oid == lost));
    let remote = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"showRemotes": true})),
        )
        .await
        .unwrap();
    assert!(remote.commits.iter().any(|commit| commit.oid == lost));
    fixture.write(TRACKED, b"stash one\n");
    fixture.git(&["stash", "push", "--message", "第一 stash"]);
    fixture.write(TRACKED, b"stash two\n");
    fixture.git(&["stash", "push", "--message", "第二 stash"]);
    let stashes = fixture
        .service
        .stashes(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(stashes.len(), 2);
    assert_eq!(stashes[0].selector, "stash@{0}");
    assert_eq!(stashes[1].selector, "stash@{1}");
    assert!(stashes[0].message.contains("第二 stash"));
    assert!(stashes.iter().all(|stash| stash.timestamp > 0));
    let refs = fixture.service.refs(&fixture.repo, REQUEST).await.unwrap();
    for stash in &stashes {
        assert!(refs.iter().any(|item| item.kind == "stash"
            && item.name == stash.selector
            && item.oid == stash.oid));
    }
    for visible in [false, true] {
        let page = fixture
            .service
            .history(
                &fixture.repo,
                history_query(
                    &fixture.repo,
                    json!({"showStashes": visible, "showRemotes": false}),
                ),
            )
            .await
            .unwrap();
        for stash in &stashes {
            assert_eq!(
                page.commits.iter().any(|commit| commit.oid == stash.oid),
                visible
            );
        }
    }
}

#[tokio::test]
async fn mailmap_can_be_disabled_without_rewriting_stored_author_data() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    fixture.write(
        ".mailmap",
        "规范 作者 <mapped@example.test> 测试 Author <author@example.test>\n".as_bytes(),
    );
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let mapped = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"mailmap": true})),
        )
        .await
        .unwrap();
    assert_eq!(mapped.commits[0].author, "规范 作者");
    assert_eq!(mapped.commits[0].email, "mapped@example.test");
    let raw = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"mailmap": false})),
        )
        .await
        .unwrap();
    assert_eq!(raw.commits[0].author, "测试 Author");
    assert_eq!(raw.commits[0].email, "author@example.test");
    let detail = fixture
        .service
        .commit_detail(&fixture.repo, &root, REQUEST, None)
        .await
        .unwrap();
    assert_eq!(detail.commit.author, "规范 作者");
    let object = fixture
        .service
        .run(
            &fixture.repo,
            REQUEST,
            vec!["cat-file".into(), "commit".into(), root],
            false,
        )
        .await
        .unwrap();
    assert!(object.contains("author 测试 Author <author@example.test>"));
}

#[tokio::test]
async fn unborn_repository_supports_empty_history_and_root_index_worktree_comparisons() {
    let fixture = Fixture::empty();
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let page = fixture
        .service
        .history(&fixture.repo, history_query(&fixture.repo, json!({})))
        .await
        .unwrap();
    assert!(page.commits.is_empty() && !page.has_more);
    let reflog = fixture
        .service
        .history(
            &fixture.repo,
            history_query(&fixture.repo, json!({"includeReflog": true})),
        )
        .await
        .unwrap();
    assert!(reflog.commits.is_empty() && !reflog.has_more);
    assert!(fixture
        .service
        .refs(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .is_empty());
    assert!(fixture
        .service
        .stashes(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .is_empty());
    let initial = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(initial.branch.as_deref(), Some("main"));
    assert!(initial.files.is_empty());
    fixture.write("staged empty.txt", b"");
    fixture.git(&["add", "--", "staged empty.txt"]);
    fixture.write("untracked 中文.txt", b"first content\n");
    let index = fixture
        .service
        .compare(&fixture.repo, comparison(&fixture.repo, None, "INDEX"))
        .await
        .unwrap();
    assert!(file(&index, "staged empty.txt").staged);
    assert_eq!(paths(&index), BTreeSet::from(["staged empty.txt"]));
    let total = fixture
        .service
        .compare(
            &fixture.repo,
            comparison(&fixture.repo, Some("HEAD"), "WORKTREE"),
        )
        .await
        .unwrap();
    assert_eq!(
        paths(&total),
        BTreeSet::from(["staged empty.txt", "untracked 中文.txt"])
    );
    let empty = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(
                &fixture.repo,
                Some("ROOT"),
                "INDEX",
                "staged empty.txt",
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(empty.old_content, None);
    assert_eq!(empty.new_content.as_deref(), Some(""));
    assert!(!empty.binary && !empty.truncated);
}

#[tokio::test]
async fn commit_details_use_empty_tree_for_roots_and_only_actual_selected_merge_parents() {
    let fixture = Fixture::seeded();
    let graph = merged_graph(&fixture);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let root = fixture
        .service
        .commit_detail(&fixture.repo, &graph.root, REQUEST, None)
        .await
        .unwrap();
    assert!(root.base.is_none() && root.commit.parents.is_empty());
    assert_eq!(root.signature.status, "N");
    assert!(paths(&root.files).contains("empty.txt"));
    assert!(root.files.iter().all(|file| file.status.starts_with('A')));
    let explicit_root = fixture
        .service
        .commit_detail(&fixture.repo, &graph.root, REQUEST, Some("ROOT"))
        .await
        .unwrap();
    assert_eq!(paths(&explicit_root.files), paths(&root.files));
    let merge = fixture
        .service
        .commit_detail(&fixture.repo, &graph.merge, REQUEST, None)
        .await
        .unwrap();
    assert_eq!(merge.base.as_deref(), Some(graph.main.as_str()));
    assert_eq!(paths(&merge.files), BTreeSet::from(["topic only.txt"]));
    let second_parent = fixture
        .service
        .commit_detail(&fixture.repo, &graph.merge, REQUEST, Some(&graph.topic))
        .await
        .unwrap();
    assert_eq!(second_parent.base.as_deref(), Some(graph.topic.as_str()));
    assert_eq!(
        paths(&second_parent.files),
        BTreeSet::from(["main only.txt"])
    );
    assert_eq!(
        fixture
            .service
            .commit_detail(&fixture.repo, &graph.merge, REQUEST, Some(&graph.root))
            .await
            .unwrap_err()
            .code,
        "ARGUMENT"
    );
    assert_eq!(
        fixture
            .service
            .commit_detail(&fixture.repo, &graph.merge, REQUEST, Some("ROOT"))
            .await
            .unwrap_err()
            .code,
        "ARGUMENT"
    );
    let topic = fixture
        .service
        .commit_detail(&fixture.repo, &graph.topic, REQUEST, None)
        .await
        .unwrap();
    assert_eq!(topic.commit.subject, "topic [literal].*");
    assert!(topic.body.contains("body-only-needle\n第二段正文"));
    assert_eq!(topic.committer_email, "author@example.test");
}

#[tokio::test]
async fn raw_signature_headers_are_reported_as_unverified_without_a_verifier() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    let tree = fixture.git(&["rev-parse", &format!("{root}^{{tree}}")]);
    let raw = format!(
        "tree {}\nparent {root}\nauthor Fixture Author <author@example.test> 1704067500 +0000\ncommitter Fixture Committer <committer@example.test> 1704067500 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n intentionally-unverified-fixture\n -----END PGP SIGNATURE-----\n\nsigned fixture\n\nraw signature body\n",
        tree.trim(),
    );
    let oid = fixture.git_input(
        &["hash-object", "-t", "commit", "-w", "--stdin"],
        raw.as_bytes(),
    );
    let unavailable_verifier = fixture.directory.path().join("must-not-run-a-verifier");
    fixture.git(&[
        "config",
        "--local",
        "gpg.program",
        unavailable_verifier.to_str().unwrap(),
    ]);
    fixture.git(&["config", "--local", "log.showSignature", "true"]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let detail = fixture
        .service
        .commit_detail(&fixture.repo, &oid, REQUEST, None)
        .await
        .unwrap();
    // U is the public signature status for a raw, signed-but-unverified commit;
    // no cryptographic validity, trust, signer identity or key is inferred.
    assert_eq!(detail.signature.status, "U");
    assert!(detail.signature.signer.is_empty() && detail.signature.key.is_empty());
    assert_eq!(detail.committer, "Fixture Committer");
    assert!(detail.body.contains("raw signature body"));
    let bytes = fixture
        .service
        .run_bytes(
            &fixture.repo,
            REQUEST,
            vec!["cat-file".into(), "commit".into(), oid],
            false,
        )
        .await
        .unwrap();
    assert_eq!(bytes, raw.as_bytes());
}

#[tokio::test]
async fn head_index_and_worktree_comparisons_separate_staged_and_unstaged_content() {
    let fixture = Fixture::seeded();
    fixture.write(TRACKED, b"staged\n");
    fixture.git(&["add", "--", TRACKED]);
    fixture.write(TRACKED, b"unstaged\n");
    fixture.git(&["mv", "--", OLD_NAME, NEW_NAME]);
    fixture.write("binary.bin", &[0, 99, 0, 255]);
    fixture.write("staged empty.txt", b"");
    fixture.git(&["add", "--", "binary.bin", "staged empty.txt"]);
    fs::remove_file(fixture.path.join("delete me.txt")).unwrap();
    fixture.write("untracked 空 白.txt", b"untracked\n");
    // The deliberately empty init template does not create .git/info.
    fixture.write(".git/info/exclude", b"*.ignored\n");
    fixture.write("keep.ignored", b"ignored\n");
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let state = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(state.conflicts, 0);
    assert!(state.operation.is_none());
    assert!(file(&state.files, TRACKED).staged && file(&state.files, TRACKED).unstaged);
    let rename = file(&state.files, NEW_NAME);
    assert_eq!(rename.old_path.as_deref(), Some(OLD_NAME));
    assert!(rename.staged && !rename.unstaged);
    assert!(file(&state.files, "delete me.txt").status.contains('D'));
    assert!(!paths(&state.files).contains("keep.ignored"));
    let total = fixture
        .service
        .compare(
            &fixture.repo,
            comparison(&fixture.repo, Some("HEAD"), "WORKTREE"),
        )
        .await
        .unwrap();
    assert_eq!(
        paths(&total),
        BTreeSet::from([
            TRACKED,
            NEW_NAME,
            "binary.bin",
            "staged empty.txt",
            "delete me.txt",
            "untracked 空 白.txt"
        ])
    );
    let staged = fixture
        .service
        .compare(
            &fixture.repo,
            comparison(&fixture.repo, Some("HEAD"), "INDEX"),
        )
        .await
        .unwrap();
    assert_eq!(
        paths(&staged),
        BTreeSet::from([TRACKED, NEW_NAME, "binary.bin", "staged empty.txt"])
    );
    assert!(staged.iter().all(|file| file.staged));
    assert_eq!(file(&staged, TRACKED).additions, Some(1));
    assert_eq!(file(&staged, TRACKED).deletions, Some(1));
    assert_eq!(file(&staged, "binary.bin").additions, None);
    let unstaged = fixture
        .service
        .compare(
            &fixture.repo,
            comparison(&fixture.repo, Some("INDEX"), "WORKTREE"),
        )
        .await
        .unwrap();
    assert_eq!(
        paths(&unstaged),
        BTreeSet::from([TRACKED, "delete me.txt", "untracked 空 白.txt"])
    );
    for (base, target, old, new) in [
        (Some("HEAD"), "WORKTREE", "base\n", "unstaged\n"),
        (Some("HEAD"), "INDEX", "base\n", "staged\n"),
        (Some("INDEX"), "WORKTREE", "staged\n", "unstaged\n"),
    ] {
        let diff = fixture
            .service
            .diff(
                &fixture.repo,
                diff_query(&fixture.repo, base, target, TRACKED, None),
            )
            .await
            .unwrap();
        assert_eq!(diff.old_content.as_deref(), Some(old));
        assert_eq!(diff.new_content.as_deref(), Some(new));
        assert!(!diff.binary && !diff.truncated);
    }
    let mut staged_override = diff_query(&fixture.repo, None, "WORKTREE", TRACKED, None);
    staged_override.staged = Some(true);
    let diff = fixture
        .service
        .diff(&fixture.repo, staged_override)
        .await
        .unwrap();
    assert_eq!(diff.new_content.as_deref(), Some("staged\n"));
}

#[tokio::test]
async fn diff_preserves_renames_binary_empty_deleted_and_literal_file_paths() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    fixture.git(&["mv", "--", OLD_NAME, NEW_NAME]);
    fs::remove_file(fixture.path.join("delete me.txt")).unwrap();
    fixture.write("binary.bin", &[0, 5, 0, 255]);
    fixture.write("new empty.txt", b"");
    fixture.write("literal[1].txt", b"changed bracket only\n");
    fixture.write("-literal.txt", b"changed dash only\n");
    let tip = fixture.commit_all("rename binary empty delete and literal paths");
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let files = fixture
        .service
        .compare(&fixture.repo, comparison(&fixture.repo, Some(&root), &tip))
        .await
        .unwrap();
    let rename = file(&files, NEW_NAME);
    assert_eq!(rename.old_path.as_deref(), Some(OLD_NAME));
    assert!(rename.status.starts_with('R'));
    assert_eq!(rename.additions, Some(0));
    assert_eq!(rename.deletions, Some(0));
    let renamed = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(&fixture.repo, Some(&root), &tip, NEW_NAME, Some(OLD_NAME)),
        )
        .await
        .unwrap();
    assert_eq!(renamed.old_content.as_deref(), Some(ORIGINAL_RENAME));
    assert_eq!(renamed.new_content.as_deref(), Some(ORIGINAL_RENAME));
    assert!(renamed.patch.contains("rename from ") && renamed.patch.contains("rename to "));
    let binary = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(&fixture.repo, Some(&root), &tip, "binary.bin", None),
        )
        .await
        .unwrap();
    assert!(binary.binary && !binary.truncated);
    assert!(binary.old_content.is_none() && binary.new_content.is_none());
    let empty = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(&fixture.repo, Some(&root), &tip, "new empty.txt", None),
        )
        .await
        .unwrap();
    assert_eq!(empty.old_content, None);
    assert_eq!(empty.new_content.as_deref(), Some(""));
    let deleted = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(&fixture.repo, Some(&root), &tip, "delete me.txt", None),
        )
        .await
        .unwrap();
    assert_eq!(deleted.old_content.as_deref(), Some("remove me\n"));
    assert_eq!(deleted.new_content, None);
    let literal = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(&fixture.repo, Some(&root), &tip, "literal[1].txt", None),
        )
        .await
        .unwrap();
    assert_eq!(
        literal.new_content.as_deref(),
        Some("changed bracket only\n")
    );
    assert!(!literal.patch.contains("different literal path"));
    let dash = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(&fixture.repo, Some(&root), &tip, "-literal.txt", None),
        )
        .await
        .unwrap();
    assert_eq!(dash.new_content.as_deref(), Some("changed dash only\n"));
    fixture.write("untracked 文本.txt", b"one\ntwo");
    fixture.write("untracked empty.txt", b"");
    let untracked = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(
                &fixture.repo,
                Some("HEAD"),
                "WORKTREE",
                "untracked 文本.txt",
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(untracked.old_content, None);
    assert_eq!(untracked.new_content.as_deref(), Some("one\ntwo"));
    assert!(untracked
        .patch
        .contains("+one\n+two\n\\ No newline at end of file"));
    let empty_untracked = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(
                &fixture.repo,
                Some("HEAD"),
                "WORKTREE",
                "untracked empty.txt",
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(empty_untracked.new_content.as_deref(), Some(""));
    assert!(empty_untracked.patch.contains("new file mode"));
    let absent = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(
                &fixture.repo,
                Some("HEAD"),
                "WORKTREE",
                "does not exist.txt",
                None,
            ),
        )
        .await
        .unwrap();
    assert!(
        absent.old_content.is_none() && absent.new_content.is_none() && absent.patch.is_empty()
    );
}

#[tokio::test]
async fn diff_encoding_and_content_limits_are_explicit() {
    let fixture = Fixture::seeded();
    fixture.write("encoded 中文.txt", &[0xd6, 0xd0, 0xce, 0xc4, b'\n']); // GBK: 中文.
    fixture.write("wide.txt", &[0xff, 0xfe, b'A', 0, b'\n', 0]);
    fixture.write("too large.txt", &vec![b'x'; 2 * 1024 * 1024 + 1]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let mut gbk = diff_query(
        &fixture.repo,
        Some("HEAD"),
        "WORKTREE",
        "encoded 中文.txt",
        None,
    );
    gbk.encoding = Some("gbk".into());
    let decoded = fixture.service.diff(&fixture.repo, gbk).await.unwrap();
    assert_eq!(decoded.new_content.as_deref(), Some("中文\n"));
    assert!(!decoded.binary);
    let mut wide = diff_query(&fixture.repo, Some("HEAD"), "WORKTREE", "wide.txt", None);
    wide.encoding = Some("auto".into());
    let decoded = fixture.service.diff(&fixture.repo, wide).await.unwrap();
    assert_eq!(decoded.new_content.as_deref(), Some("A\n"));
    assert!(!decoded.binary);
    let bounded = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(
                &fixture.repo,
                Some("HEAD"),
                "WORKTREE",
                "too large.txt",
                None,
            ),
        )
        .await
        .unwrap();
    assert!(bounded.truncated);
    assert!(bounded.new_content.is_none() && bounded.patch.is_empty());
    let mut invalid = diff_query(&fixture.repo, Some("HEAD"), "WORKTREE", TRACKED, None);
    invalid.encoding = Some("not-a-file-encoding".into());
    assert_eq!(
        fixture
            .service
            .diff(&fixture.repo, invalid)
            .await
            .unwrap_err()
            .code,
        "ARGUMENT"
    );
}

#[tokio::test]
async fn branch_actions_create_rename_checkout_delete_and_detach_without_discarding() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "branch-create",
        json!({"name": "测试/feature", "target": root}),
    )
    .await
    .unwrap();
    assert!(fixture.ref_exists("refs/heads/测试/feature"));
    perform(
        &fixture.service,
        &fixture.repo,
        "branch-rename",
        json!({"target": "refs/heads/测试/feature", "name": "renamed/feature"}),
    )
    .await
    .unwrap();
    assert!(!fixture.ref_exists("refs/heads/测试/feature"));
    assert!(fixture.ref_exists("refs/heads/renamed/feature"));
    perform(
        &fixture.service,
        &fixture.repo,
        "checkout",
        json!({"target": "renamed/feature"}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.git(&["symbolic-ref", "HEAD"]).trim(),
        "refs/heads/renamed/feature"
    );
    assert!(perform(
        &fixture.service,
        &fixture.repo,
        "branch-delete",
        json!({"target": "renamed/feature"})
    )
    .await
    .is_err());
    assert!(fixture.ref_exists("refs/heads/renamed/feature"));
    perform(
        &fixture.service,
        &fixture.repo,
        "checkout",
        json!({"target": root}),
    )
    .await
    .unwrap();
    assert!(fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .branch
        .is_none());
    perform(
        &fixture.service,
        &fixture.repo,
        "checkout",
        json!({"target": "refs/heads/main"}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "branch-delete",
        json!({"target": "renamed/feature", "force": false}),
    )
    .await
    .unwrap();
    assert!(!fixture.ref_exists("refs/heads/renamed/feature"));
    assert_eq!(fixture.head(), root);
    fixture.write(TRACKED, b"keep local work\n");
    let forced = perform(
        &fixture.service,
        &fixture.repo,
        "checkout",
        json!({"target": root, "force": true}),
    )
    .await
    .unwrap_err();
    assert_eq!(forced.code, "INVALID_ACTION");
    assert_eq!(
        fs::read(fixture.path.join(TRACKED)).unwrap(),
        b"keep local work\n"
    );
}

#[tokio::test]
async fn merge_and_reset_actions_update_real_parents_index_and_worktree() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    fixture.git(&["branch", "topic", &root]);
    fixture.write("main side.txt", b"main\n");
    let main = fixture.commit_all("main-side action fixture");
    fixture.git(&["switch", "--quiet", "topic"]);
    fixture.write("topic side.txt", b"topic\n");
    let topic = fixture.commit_all("topic-side action fixture");
    fixture.git(&["switch", "--quiet", "main"]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let result = perform(
        &fixture.service,
        &fixture.repo,
        "merge",
        json!({"target": topic, "noFastForward": true, "sign": false}),
    )
    .await
    .unwrap();
    assert!(result.operation.is_none());
    let merge = fixture.head();
    assert_eq!(
        fixture
            .git(&["rev-list", "--parents", "-1", "HEAD"])
            .split_whitespace()
            .collect::<Vec<_>>(),
        vec![merge.as_str(), main.as_str(), topic.as_str()]
    );
    assert_eq!(
        fs::read(fixture.path.join("topic side.txt")).unwrap(),
        b"topic\n"
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "reset",
        json!({"target": main, "mode": "soft"}),
    )
    .await
    .unwrap();
    assert_eq!(fixture.head(), main);
    let state = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert!(file(&state.files, "topic side.txt").staged);
    perform(
        &fixture.service,
        &fixture.repo,
        "reset",
        json!({"target": main, "mode": "mixed"}),
    )
    .await
    .unwrap();
    let state = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert!(!file(&state.files, "topic side.txt").staged);
    assert!(fixture.path.join("topic side.txt").exists());
    let error = perform(
        &fixture.service,
        &fixture.repo,
        "reset",
        json!({"target": merge, "mode": "hard"}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "CONFIRMATION_REQUIRED");
    assert_eq!(fixture.head(), main);
    perform(
        &fixture.service,
        &fixture.repo,
        "reset",
        json!({"target": merge, "mode": "hard", "force": true}),
    )
    .await
    .unwrap();
    fixture.write(TRACKED, b"discard this tracked edit\n");
    perform(
        &fixture.service,
        &fixture.repo,
        "reset",
        json!({"target": main, "mode": "hard", "force": true}),
    )
    .await
    .unwrap();
    assert!(!fixture.path.join("topic side.txt").exists());
    assert_eq!(fs::read(fixture.path.join(TRACKED)).unwrap(), b"base\n");
    assert!(fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .files
        .is_empty());
}

#[tokio::test]
async fn no_commit_merge_stops_fast_forward_and_follow_up_commits_only_the_index() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    fixture.git(&["switch", "--quiet", "--create", "topic"]);
    fixture.write("reviewed.txt", b"staged topic\n");
    let topic = fixture.commit_all("topic to review");
    fixture.git(&["switch", "--quiet", "main"]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let merge = perform(
        &fixture.service,
        &fixture.repo,
        "merge",
        json!({"target": topic, "noCommit": true, "sign": false}),
    )
    .await
    .unwrap();
    assert_eq!(fixture.head(), root);
    assert_eq!(merge.operation.as_deref(), Some("merge"));
    assert!(Path::new(&fixture.repo.git_dir).join("MERGE_HEAD").exists());
    fixture.write(TRACKED, b"unstaged work must not be committed\n");
    let committed = perform(
        &fixture.service,
        &fixture.repo,
        "commit",
        json!({"message": "reviewed merge", "sign": false}),
    )
    .await
    .unwrap();
    assert!(committed.operation.is_none());
    assert_eq!(fixture.git(&["show", "HEAD:tracked 中文.txt"]), "base\n");
    assert_eq!(
        fixture.git(&["show", "HEAD:reviewed.txt"]),
        "staged topic\n"
    );
    assert_eq!(
        fs::read(fixture.path.join(TRACKED)).unwrap(),
        b"unstaged work must not be committed\n"
    );
    assert_eq!(
        fixture
            .git(&["rev-list", "--parents", "-1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
    fixture.git(&["add", "--", TRACKED]);
    let error = perform(
        &fixture.service,
        &fixture.repo,
        "commit",
        json!({"message": "unconfirmed index commit"}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "FOLLOW_UP_CONFIRMATION_REQUIRED");
    perform(&fixture.service, &fixture.repo, "commit", json!({"message": "confirmed index commit", "force": true, "mode": "follow-up", "sign": false})).await.unwrap();
    assert!(fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .files
        .is_empty());
}

#[tokio::test]
async fn cherry_pick_revert_and_no_commit_apply_actual_changes() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    fixture.git(&["switch", "--quiet", "--create", "source"]);
    fixture.write("picked.txt", b"picked contents\n");
    let source = fixture.commit_all("source cherry-pick");
    fixture.git(&["switch", "--quiet", "main"]);
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "cherry-pick",
        json!({"target": source, "sign": false}),
    )
    .await
    .unwrap();
    let picked = fixture.head();
    assert_ne!(picked, root);
    assert_eq!(fixture.git(&["rev-parse", "HEAD^1"]).trim(), root);
    assert_eq!(
        fs::read(fixture.path.join("picked.txt")).unwrap(),
        b"picked contents\n"
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "revert",
        json!({"target": picked, "sign": false}),
    )
    .await
    .unwrap();
    let reverted = fixture.head();
    assert_ne!(reverted, picked);
    assert!(!fixture.path.join("picked.txt").exists());
    assert_eq!(fixture.git(&["rev-parse", "HEAD^1"]).trim(), picked);
    perform(
        &fixture.service,
        &fixture.repo,
        "cherry-pick",
        json!({"target": source, "noCommit": true, "sign": false}),
    )
    .await
    .unwrap();
    assert_eq!(fixture.head(), reverted);
    let state = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert!(file(&state.files, "picked.txt").staged);
    perform(
        &fixture.service,
        &fixture.repo,
        "commit",
        json!({"message": "reviewed pick", "force": true, "mode": "follow-up", "sign": false}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.git(&["show", "HEAD:picked.txt"]),
        "picked contents\n"
    );
}

#[tokio::test]
async fn conflicted_merge_preserves_state_for_abort_or_explicit_resolution_and_continue() {
    let fixture = Fixture::seeded();
    fixture.git(&["switch", "--quiet", "--create", "topic"]);
    fixture.write(TRACKED, b"topic conflict\n");
    let topic = fixture.commit_all("topic conflicting edit");
    fixture.git(&["switch", "--quiet", "main"]);
    fixture.write(TRACKED, b"main conflict\n");
    let main = fixture.commit_all("main conflicting edit");
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let error = perform(
        &fixture.service,
        &fixture.repo,
        "merge",
        json!({"target": topic, "sign": false}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "GIT");
    let conflicted = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(conflicted.operation.as_deref(), Some("merge"));
    assert_eq!(conflicted.conflicts, 1);
    assert!(file(&conflicted.files, TRACKED).status.contains('U'));
    assert_eq!(
        perform(
            &fixture.service,
            &fixture.repo,
            "checkout",
            json!({"target": "main"})
        )
        .await
        .unwrap_err()
        .code,
        "OPERATION_IN_PROGRESS"
    );
    assert_eq!(
        perform(
            &fixture.service,
            &fixture.repo,
            "commit",
            json!({"message": "not resolved", "sign": false})
        )
        .await
        .unwrap_err()
        .code,
        "UNRESOLVED_CONFLICTS"
    );
    perform(&fixture.service, &fixture.repo, "abort", json!({}))
        .await
        .unwrap();
    assert_eq!(fixture.head(), main);
    assert_eq!(
        fs::read(fixture.path.join(TRACKED)).unwrap(),
        b"main conflict\n"
    );
    assert!(fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .operation
        .is_none());
    assert!(perform(
        &fixture.service,
        &fixture.repo,
        "merge",
        json!({"target": topic, "sign": false})
    )
    .await
    .is_err());
    fixture.write(TRACKED, b"resolved content\n");
    fixture.git(&["add", "--", TRACKED]);
    perform(&fixture.service, &fixture.repo, "continue", json!({}))
        .await
        .unwrap();
    let resolved = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert!(resolved.files.is_empty() && resolved.operation.is_none());
    assert_eq!(
        fixture.git(&["show", "HEAD:tracked 中文.txt"]),
        "resolved content\n"
    );
    let merge = fixture.head();
    assert_eq!(
        fixture
            .git(&["rev-list", "--parents", "-1", "HEAD"])
            .split_whitespace()
            .collect::<Vec<_>>(),
        vec![merge.as_str(), main.as_str(), topic.as_str()]
    );
}

#[tokio::test]
async fn stash_actions_restore_index_untracked_files_and_only_drop_successfully_applied_entries() {
    let fixture = Fixture::seeded();
    fixture.write(TRACKED, b"staged stash\n");
    fixture.git(&["add", "--", TRACKED]);
    fixture.write(TRACKED, b"unstaged stash\n");
    fixture.write("stash untracked.txt", b"untracked stash\n");
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let saved_result = perform(
        &fixture.service,
        &fixture.repo,
        "stash-save",
        json!({"message": "测试 stash", "includeUntracked": true}),
    )
    .await
    .unwrap();
    let after_save = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert!(
        after_save.files.is_empty(),
        "stash-save output: {}\nstate: {after_save:#?}\nGit status: {}",
        saved_result.output,
        fixture.git(&["status", "--porcelain=v2", "--untracked-files=all"])
    );
    assert!(!fixture.path.join("stash untracked.txt").exists());
    let saved = fixture
        .service
        .stashes(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(saved.len(), 1);
    assert!(saved[0].message.contains("测试 stash"));
    perform(
        &fixture.service,
        &fixture.repo,
        "stash-apply",
        json!({"target": "stash@{0}", "mode": "index"}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.git(&["show", ":tracked 中文.txt"]),
        "staged stash\n"
    );
    assert_eq!(
        fs::read(fixture.path.join(TRACKED)).unwrap(),
        b"unstaged stash\n"
    );
    assert_eq!(
        fs::read(fixture.path.join("stash untracked.txt")).unwrap(),
        b"untracked stash\n"
    );
    assert_eq!(
        fixture
            .service
            .stashes(&fixture.repo, REQUEST)
            .await
            .unwrap()[0]
            .oid,
        saved[0].oid
    );
    fixture.git(&["reset", "--hard", "HEAD"]);
    fs::remove_file(fixture.path.join("stash untracked.txt")).unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "stash-pop",
        json!({"target": "stash@{0}", "mode": "index"}),
    )
    .await
    .unwrap();
    assert!(fixture
        .service
        .stashes(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        fixture.git(&["show", ":tracked 中文.txt"]),
        "staged stash\n"
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "stash-save",
        json!({"message": "drop this entry", "includeUntracked": true}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "stash-drop",
        json!({"target": "stash@{0}"}),
    )
    .await
    .unwrap();
    assert!(fixture
        .service
        .stashes(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .is_empty());
    fixture.write(TRACKED, b"branch stash\n");
    perform(
        &fixture.service,
        &fixture.repo,
        "stash-save",
        json!({"message": "branch entry"}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "stash-branch",
        json!({"target": "stash@{0}", "name": "stash/recovered"}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.git(&["symbolic-ref", "--short", "HEAD"]).trim(),
        "stash/recovered"
    );
    assert_eq!(
        fs::read(fixture.path.join(TRACKED)).unwrap(),
        b"branch stash\n"
    );
    assert!(fixture
        .service
        .stashes(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn tag_and_identity_actions_use_local_scope_and_preserve_annotated_tag_targets() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    let isolated_global_before = fs::read(fixture.home.join(".gitconfig")).unwrap();
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    perform(&fixture.service, &fixture.repo, "identity", json!({"name": "姓名 Local", "email": "local@example.test", "global": false, "mode": "local"})).await.unwrap();
    let config = fixture
        .service
        .repo_config(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(config.user_name, "姓名 Local");
    assert_eq!(config.user_email, "local@example.test");
    assert!(config.global_user_name.is_empty() && config.global_user_email.is_empty());
    assert!(!config.sign_commits);
    assert_eq!(
        fixture
            .git(&["config", "--local", "--get", "user.name"])
            .trim(),
        "姓名 Local"
    );
    assert_eq!(
        fs::read(fixture.home.join(".gitconfig")).unwrap(),
        isolated_global_before
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "tag-create",
        json!({"name": "测试-v1", "target": root, "sign": false}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "tag-create",
        json!({"name": "annotated-v1", "target": root, "message": "发布说明 中文", "sign": false}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture.git(&["cat-file", "-t", "refs/tags/测试-v1"]).trim(),
        "commit"
    );
    assert_eq!(
        fixture
            .git(&["cat-file", "-t", "refs/tags/annotated-v1"])
            .trim(),
        "tag"
    );
    let refs = fixture.service.refs(&fixture.repo, REQUEST).await.unwrap();
    assert!(refs
        .iter()
        .any(|item| item.full_name == "refs/tags/annotated-v1" && item.oid == root));
    perform(
        &fixture.service,
        &fixture.repo,
        "tag-delete",
        json!({"target": "测试-v1"}),
    )
    .await
    .unwrap();
    assert!(!fixture.ref_exists("refs/tags/测试-v1"));
    assert!(fixture.ref_exists("refs/tags/annotated-v1"));
}

#[tokio::test]
async fn local_remote_actions_push_fetch_pull_edit_prune_and_set_upstream() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    let bare = fixture.bare("bare remote 空 格.git");
    let alternate = fixture.bare("alternate push 空 格.git");
    let url = bare.to_str().unwrap();
    let alternate_url = alternate.to_str().unwrap();
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "remote-add",
        json!({"remote": "origin", "url": url}),
    )
    .await
    .unwrap();
    let remote = fixture
        .service
        .remotes(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(remote.len(), 1);
    assert_eq!(remote[0].fetch_url, url);
    assert_eq!(remote[0].push_url, url);
    perform(
        &fixture.service,
        &fixture.repo,
        "push",
        json!({"remote": "origin", "branch": "main", "setUpstream": true}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .git_at(&bare, &["rev-parse", "refs/heads/main"])
            .trim(),
        root
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "remote-edit",
        json!({"remote": "origin", "mode": "push", "url": alternate_url}),
    )
    .await
    .unwrap();
    let remote = fixture
        .service
        .remotes(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!(remote[0].fetch_url, url);
    assert_eq!(remote[0].push_url, alternate_url);
    perform(
        &fixture.service,
        &fixture.repo,
        "remote-edit",
        json!({"remote": "origin", "mode": "fetch", "url": alternate_url}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .service
            .remotes(&fixture.repo, REQUEST)
            .await
            .unwrap()[0]
            .fetch_url,
        alternate_url
    );
    for mode in ["fetch", "push"] {
        perform(
            &fixture.service,
            &fixture.repo,
            "remote-edit",
            json!({"remote": "origin", "mode": mode, "url": url}),
        )
        .await
        .unwrap();
    }
    let donor = fixture.clone_local(&bare, "donor clone 中文");
    fs::write(donor.join("from donor.txt"), b"remote change\n").unwrap();
    fixture.git_at(&donor, &["add", "--all", "--", "."]);
    let donor_oid = fixture.commit_index_at(&donor, "remote-only commit");
    fixture.git_at(
        &donor,
        &[
            "-c",
            "protocol.file.allow=always",
            "push",
            "--quiet",
            "origin",
            "main",
        ],
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "fetch",
        json!({"remote": "origin"}),
    )
    .await
    .unwrap();
    assert_eq!(fixture.head(), root);
    assert_eq!(
        fixture
            .git(&["rev-parse", "refs/remotes/origin/main"])
            .trim(),
        donor_oid
    );
    let behind = fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap();
    assert_eq!((behind.ahead, behind.behind), (0, 1));
    perform(
        &fixture.service,
        &fixture.repo,
        "pull",
        json!({"remote": "origin", "branch": "main", "mode": "ff-only", "sign": false}),
    )
    .await
    .unwrap();
    assert_eq!(fixture.head(), donor_oid);
    assert_eq!(
        fs::read(fixture.path.join("from donor.txt")).unwrap(),
        b"remote change\n"
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "branch-create",
        json!({"name": "tracking", "target": "HEAD"}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "set-upstream",
        json!({"branch": "tracking", "remote": "origin", "target": "main"}),
    )
    .await
    .unwrap();
    let refs = fixture.service.refs(&fixture.repo, REQUEST).await.unwrap();
    assert_eq!(
        refs.iter()
            .find(|item| item.full_name == "refs/heads/tracking")
            .unwrap()
            .upstream
            .as_deref(),
        Some("refs/remotes/origin/main")
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "tag-create",
        json!({"name": "remote-tag", "target": "HEAD"}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "tag-push",
        json!({"remote": "origin", "target": "remote-tag"}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .git_at(&bare, &["rev-parse", "refs/tags/remote-tag"])
            .trim(),
        donor_oid
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "branch-create",
        json!({"name": "ghost", "target": "HEAD"}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "push",
        json!({"remote": "origin", "branch": "ghost"}),
    )
    .await
    .unwrap();
    assert!(fixture.ref_exists("refs/remotes/origin/ghost"));
    fixture.git_at(&bare, &["update-ref", "-d", "refs/heads/ghost"]);
    perform(
        &fixture.service,
        &fixture.repo,
        "prune",
        json!({"remote": "origin"}),
    )
    .await
    .unwrap();
    assert!(!fixture.ref_exists("refs/remotes/origin/ghost"));
    perform(
        &fixture.service,
        &fixture.repo,
        "remote-remove",
        json!({"remote": "origin"}),
    )
    .await
    .unwrap();
    assert!(fixture
        .service
        .remotes(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .is_empty());
    assert!(!fixture.ref_exists("refs/remotes/origin/main"));
}

#[tokio::test]
async fn force_with_lease_refuses_stale_remote_and_allows_rewrite_only_after_fetch() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    let bare = fixture.bare("lease remote 中文.git");
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "remote-add",
        json!({"remote": "origin", "url": bare.to_str().unwrap()}),
    )
    .await
    .unwrap();
    perform(
        &fixture.service,
        &fixture.repo,
        "push",
        json!({"remote": "origin", "branch": "main", "setUpstream": true}),
    )
    .await
    .unwrap();
    fixture.write("first published.txt", b"published\n");
    let published = fixture.commit_all("first published commit");
    perform(
        &fixture.service,
        &fixture.repo,
        "push",
        json!({"remote": "origin", "branch": "main"}),
    )
    .await
    .unwrap();
    let donor = fixture.clone_local(&bare, "other writer 中文");
    fs::write(
        donor.join("someone else.txt"),
        b"must not be silently overwritten\n",
    )
    .unwrap();
    fixture.git_at(&donor, &["add", "--all", "--", "."]);
    let advanced = fixture.commit_index_at(&donor, "another writer advanced remote");
    fixture.git_at(
        &donor,
        &[
            "-c",
            "protocol.file.allow=always",
            "push",
            "--quiet",
            "origin",
            "main",
        ],
    );
    assert_eq!(
        fixture
            .git(&["rev-parse", "refs/remotes/origin/main"])
            .trim(),
        published
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "reset",
        json!({"target": root, "mode": "hard", "force": true}),
    )
    .await
    .unwrap();
    fixture.write("rewritten.txt", b"reviewed rewrite\n");
    let rewritten = fixture.commit_all("replacement history");
    let rejected = perform(
        &fixture.service,
        &fixture.repo,
        "push",
        json!({"remote": "origin", "branch": "main", "force": true}),
    )
    .await
    .unwrap_err();
    assert_eq!(rejected.code, "GIT");
    assert_eq!(
        fixture
            .git_at(&bare, &["rev-parse", "refs/heads/main"])
            .trim(),
        advanced
    );
    assert_eq!(
        fixture
            .git(&["rev-parse", "refs/remotes/origin/main"])
            .trim(),
        published
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "fetch",
        json!({"remote": "origin", "branch": "main"}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .git(&["rev-parse", "refs/remotes/origin/main"])
            .trim(),
        advanced
    );
    perform(
        &fixture.service,
        &fixture.repo,
        "push",
        json!({"remote": "origin", "branch": "main", "force": true}),
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .git_at(&bare, &["rev-parse", "refs/heads/main"])
            .trim(),
        rewritten
    );
    assert_eq!(
        fixture
            .git(&["rev-parse", "refs/remotes/origin/main"])
            .trim(),
        rewritten
    );
}

#[tokio::test]
async fn public_queries_reject_options_traversal_and_unsafe_action_grammars() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    let config_before = fs::read(fixture.path.join(".git/config")).unwrap();
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    for options in [
        json!({"revision": "--all"}),
        json!({"revision": "HEAD~1"}),
        json!({"revision": "HEAD:tracked 中文.txt"}),
        json!({"order": "--date-order"}),
        json!({"searchMode": "--author"}),
        json!({"limit": 0}),
        json!({"limit": 1001}),
        json!({"searchMode": "date", "search": "2024-02-30"}),
    ] {
        assert_eq!(
            fixture
                .service
                .history(&fixture.repo, history_query(&fixture.repo, options.clone()))
                .await
                .unwrap_err()
                .code,
            "ARGUMENT",
            "{options}"
        );
    }
    for path in [
        "../outside.txt",
        "a/../outside.txt",
        "/absolute.txt",
        "C:/outside.txt",
        ".git/config",
        "nested/.GIT/config",
        "a\\b",
        "file:stream",
        ":(top)*",
        "a//b",
    ] {
        let error = fixture
            .service
            .diff(
                &fixture.repo,
                diff_query(&fixture.repo, Some("HEAD"), "WORKTREE", path, None),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "ARGUMENT", "unsafe path {path:?}");
    }
    let old_path = diff_query(
        &fixture.repo,
        Some("HEAD"),
        "WORKTREE",
        TRACKED,
        Some("../outside.txt"),
    );
    assert_eq!(
        fixture
            .service
            .diff(&fixture.repo, old_path)
            .await
            .unwrap_err()
            .code,
        "ARGUMENT"
    );
    for (kind, fields) in [
        ("branch-create", json!({"name": "--bad", "target": "HEAD"})),
        ("branch-create", json!({"name": "a/../b", "target": "HEAD"})),
        (
            "branch-create",
            json!({"name": "bad.lock", "target": "HEAD"}),
        ),
        ("checkout", json!({"target": "--help"})),
        ("checkout", json!({"target": "HEAD~1"})),
        ("merge", json!({"target": "HEAD:tracked 中文.txt"})),
        ("reset", json!({"target": "HEAD", "mode": "--hard"})),
        (
            "remote-add",
            json!({"remote": "--upload-pack", "url": "./unused"}),
        ),
        (
            "remote-add",
            json!({"remote": "unsafe", "url": "ext::must-not-run"}),
        ),
        (
            "remote-add",
            json!({"remote": "unsafe", "url": "file://remote-server/share/repo.git"}),
        ),
        ("stash-drop", json!({"target": "stash@{-1}"})),
        ("identity", json!({"name": "bad\nname", "global": false})),
        ("not-an-action", json!({})),
    ] {
        let error = perform(&fixture.service, &fixture.repo, kind, fields.clone())
            .await
            .unwrap_err();
        assert!(
            matches!(error.code.as_str(), "INVALID_ACTION" | "UNSUPPORTED_ACTION"),
            "{kind} {fields}: {error}"
        );
    }
    assert_eq!(fixture.head(), root);
    assert_eq!(
        fs::read(fixture.path.join(".git/config")).unwrap(),
        config_before
    );
    assert!(fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .files
        .is_empty());
}

#[tokio::test]
async fn untrusted_repositories_allow_reads_but_reject_runner_and_action_writes() {
    let fixture = Fixture::seeded();
    let root = fixture.head();
    let mut untrusted = fixture.repo.clone();
    untrusted.trusted = false;
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    assert!(!fixture
        .service
        .refs(&untrusted, REQUEST)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        fixture
            .service
            .history(&untrusted, history_query(&untrusted, json!({})))
            .await
            .unwrap()
            .commits[0]
            .oid,
        root
    );
    let error = fixture
        .service
        .run(
            &untrusted,
            REQUEST,
            vec![
                "config".into(),
                "--local".into(),
                "user.name".into(),
                "must not write".into(),
            ],
            true,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "UNTRUSTED");
    assert_eq!(
        perform(
            &fixture.service,
            &untrusted,
            "branch-create",
            json!({"name": "must-not-exist", "target": "HEAD"})
        )
        .await
        .unwrap_err()
        .code,
        "UNTRUSTED"
    );
    assert!(!fixture.ref_exists("refs/heads/must-not-exist"));
    assert_eq!(
        fixture
            .git(&["config", "--local", "--get", "user.name"])
            .trim(),
        "测试 Author"
    );
    assert_eq!(fixture.head(), root);
}

#[tokio::test]
async fn linked_worktree_operation_markers_are_not_confused_with_common_git_directory() {
    let fixture = Fixture::seeded();
    fixture.git(&["switch", "--quiet", "--create", "topic"]);
    fixture.write(TRACKED, b"topic worktree conflict\n");
    let topic = fixture.commit_all("topic worktree fixture");
    fixture.git(&["switch", "--quiet", "main"]);
    fixture.write(TRACKED, b"main worktree conflict\n");
    let main = fixture.commit_all("main worktree fixture");
    let linked_path = fixture.directory.path().join("linked worktree 中文");
    fixture.git(&[
        "worktree",
        "add",
        "--quiet",
        "--detach",
        linked_path.to_str().unwrap(),
        &main,
    ]);
    let git_dir = fixture
        .git_at(&linked_path, &["rev-parse", "--absolute-git-dir"])
        .trim()
        .to_owned();
    let linked = Repository {
        id: "linked-worktree".into(),
        path: linked_path.to_string_lossy().into_owned(),
        name: "linked worktree 中文".into(),
        git_dir,
        common_dir: fixture.repo.common_dir.clone(),
        head: Some(main.clone()),
        branch: None,
        trusted: true,
        bare: false,
    };
    assert!(linked_path.join(".git").is_file());
    assert_ne!(Path::new(&linked.git_dir), Path::new(&linked.common_dir));
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    assert!(fixture
        .service
        .working_state(&linked, REQUEST)
        .await
        .unwrap()
        .branch
        .is_none());
    assert!(perform(
        &fixture.service,
        &linked,
        "merge",
        json!({"target": topic, "sign": false})
    )
    .await
    .is_err());
    let linked_state = fixture
        .service
        .working_state(&linked, REQUEST)
        .await
        .unwrap();
    assert_eq!(linked_state.operation.as_deref(), Some("merge"));
    assert_eq!(linked_state.conflicts, 1);
    assert!(fixture
        .service
        .working_state(&fixture.repo, REQUEST)
        .await
        .unwrap()
        .operation
        .is_none());
    assert!(Path::new(&linked.git_dir).join("MERGE_HEAD").exists());
    assert!(!Path::new(&linked.common_dir).join("MERGE_HEAD").exists());
    perform(&fixture.service, &linked, "abort", json!({}))
        .await
        .unwrap();
    assert_eq!(
        fixture.git_at(&linked_path, &["rev-parse", "HEAD"]).trim(),
        main
    );
    assert!(fixture
        .service
        .working_state(&linked, REQUEST)
        .await
        .unwrap()
        .files
        .is_empty());
    fs::write(linked_path.join("linked only.txt"), b"linked content\n").unwrap();
    let diff = fixture
        .service
        .diff(
            &linked,
            diff_query(&linked, Some("HEAD"), "WORKTREE", "linked only.txt", None),
        )
        .await
        .unwrap();
    assert_eq!(diff.new_content.as_deref(), Some("linked content\n"));
    assert!(!fixture.path.join("linked only.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn worktree_diff_never_follows_a_parent_symlink_outside_repository() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::seeded();
    let outside = fixture.directory.path().join("outside directory");
    fs::create_dir(&outside).unwrap();
    fs::write(
        outside.join("secret.txt"),
        b"must not be read through symlink\n",
    )
    .unwrap();
    symlink(&outside, fixture.path.join("outside-link")).unwrap();
    let _request = fixture.service.begin_request(REQUEST).unwrap();
    let error = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(
                &fixture.repo,
                Some("HEAD"),
                "WORKTREE",
                "outside-link/secret.txt",
                None,
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "ARGUMENT");
    let link = fixture
        .service
        .diff(
            &fixture.repo,
            diff_query(
                &fixture.repo,
                Some("HEAD"),
                "WORKTREE",
                "outside-link",
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(link.new_content.as_deref(), outside.to_str());
    assert!(!link.patch.contains("must not be read through symlink"));
}
