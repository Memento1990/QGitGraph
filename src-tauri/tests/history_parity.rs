//! Independent backend parity fixtures built with local Git's documented CLI.
//! Every repository/home/template is temporary; no global config or network use.

use qgitgraph_lib::{
    git::GitService,
    model::{HistoryPage, HistoryQuery, Repository},
};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

const REQUEST: &str = "history-parity";

struct Fixture {
    root: TempDir,
    home: PathBuf,
    path: PathBuf,
    service: GitService,
    repo: Repository,
    clock: Cell<i64>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("qgitgraph-history-parity-")
            .tempdir()
            .unwrap();
        let path = root.path().join("仓库 with spaces");
        let home = root.path().join("isolated home");
        for entry in [
            &path,
            &home,
            &root.path().join("templates"),
            &root.path().join("hooks"),
        ] {
            fs::create_dir(entry).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "history-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "history fixture".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: Some("0".repeat(40)),
            branch: Some("deliberately-stale".into()),
            trusted: true,
            bare: false,
        };
        let fixture = Self {
            root,
            home,
            path,
            service,
            repo,
            clock: Cell::new(1704067200),
        };
        fixture.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--template",
            fixture.root.path().join("templates").to_str().unwrap(),
        ]);
        fixture.configure(&fixture.path);
        fixture
    }

    fn configure(&self, path: &Path) {
        for (key, value) in [
            ("user.name", "测试 Author"),
            ("user.email", "fixture@example.test"),
            ("core.autocrlf", "false"),
            ("core.filemode", "false"),
            ("core.logAllRefUpdates", "true"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("credential.helper", ""),
            ("submodule.recurse", "false"),
        ] {
            self.git_at(path, &["config", "--local", key, value]);
        }
        self.git_at(
            path,
            &[
                "config",
                "--local",
                "core.hooksPath",
                self.root.path().join("hooks").to_str().unwrap(),
            ],
        );
    }

    fn command(&self, path: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(self.service.git_path());
        command.current_dir(path);
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
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .args([
                "--no-pager",
                "-c",
                "color.ui=false",
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
                self.root.path().join("hooks").display()
            ))
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn git_at(&self, path: &Path, args: &[&str]) -> String {
        let output = self.command(path, args).output().unwrap();
        assert!(
            output.status.success(),
            "Git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.path, args)
    }
    fn input(&self, args: &[&str], input: &str) -> String {
        let mut command = self.command(&self.path, args);
        command.stdin(Stdio::piped());
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }
    fn write(&self, path: &str, value: &str) {
        let path = self.path.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }
    fn commit(&self, subject: &str) -> String {
        self.clock.set(self.clock.get() + 60);
        self.git(&["add", "--all", "--", "."]);
        self.git(&[
            "commit",
            "--quiet",
            "--allow-empty",
            "--no-gpg-sign",
            "--message",
            subject,
        ]);
        self.git(&["rev-parse", "HEAD"]).trim().into()
    }
    fn detached_commit(&self, parent: Option<&str>, message: &str) -> String {
        self.clock.set(self.clock.get() + 60);
        let tree = self.git(&["rev-parse", "HEAD^{tree}"]);
        let mut args = vec!["commit-tree", tree.trim(), "--no-gpg-sign", "-m", message];
        if let Some(parent) = parent {
            args.extend(["-p", parent]);
        }
        self.git(&args).trim().into()
    }
    async fn history(&self, overrides: Value) -> HistoryPage {
        self.service
            .history(&self.repo, self.query(overrides))
            .await
            .unwrap()
    }
    fn query(&self, overrides: Value) -> HistoryQuery {
        let mut value = json!({"repoId": self.repo.id, "requestId": REQUEST, "offset": 0, "limit": 1000,
            "order": "topo", "showRemotes": true, "showTags": true, "showStashes": true,
            "includeReflog": false, "includeTagOnly": true, "collapseStashAuxiliary": true, "mailmap": false});
        value
            .as_object_mut()
            .unwrap()
            .extend(overrides.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }
}

fn ids(page: &HistoryPage) -> BTreeSet<String> {
    page.commits
        .iter()
        .map(|commit| commit.oid.clone())
        .collect()
}

#[tokio::test]
async fn multiple_exact_refs_globs_and_129_tips_never_widen_to_all() {
    let f = Fixture::new();
    let root = f.commit("root");
    let unrelated = f.detached_commit(None, "unrelated should stay out");
    f.git(&["update-ref", "refs/heads/unrelated", &unrelated]);
    let mut selected = BTreeSet::from([root.clone()]);
    let mut refs = Vec::new();
    let mut transaction = String::from("start\n");
    for index in 0..129 {
        let oid = f.detached_commit(Some(&root), &format!("selected {index}"));
        let name = format!("refs/heads/selected/{index:03}");
        transaction.push_str(&format!("create {name} {oid}\n"));
        refs.push(name);
        selected.insert(oid);
    }
    transaction.push_str("prepare\ncommit\n");
    f.input(&["update-ref", "--stdin"], &transaction);
    let _request = f.service.begin_request(REQUEST).unwrap();
    let exact = f
        .history(json!({"scope": {"kind": "refs", "refs": refs}}))
        .await;
    assert_eq!(ids(&exact), selected);
    assert!(!exact.has_more);
    let glob = f
        .history(
            json!({"scope": {"kind": "glob", "include": ["refs/heads/selected/*"], "exclude": []}}),
        )
        .await;
    assert_eq!(ids(&glob), selected);
    let excluded = f.history(json!({"scope": {"kind": "glob", "include": ["refs/heads/selected/*"], "exclude": ["refs/heads/selected/0??"]}})).await;
    assert_eq!(excluded.commits.len(), 30); // 100..128 plus shared root.
    for scope in [
        json!({"kind": "refs", "refs": []}),
        json!({"kind": "refs", "refs": ["refs/heads/not-present"]}),
        json!({"kind": "glob", "include": ["refs/heads/not-present/*"], "exclude": []}),
        json!({"kind": "glob", "include": []}),
    ] {
        let page = f
            .history(json!({"scope": scope, "includeReflog": true}))
            .await;
        assert!(page.commits.is_empty() && !page.has_more);
    }
    let mut paged = Vec::new();
    for offset in (0..exact.commits.len()).step_by(17) {
        let page = f.history(json!({"scope": {"kind": "glob", "include": ["refs/heads/selected/*"]}, "offset": offset, "limit": 17})).await;
        assert_eq!(
            page.has_more,
            offset + page.commits.len() < exact.commits.len()
        );
        paged.extend(page.commits.into_iter().map(|commit| commit.oid));
    }
    assert_eq!(
        paged,
        exact
            .commits
            .iter()
            .map(|commit| commit.oid.clone())
            .collect::<Vec<_>>()
    );
    for scope in [
        json!({"kind": "refs", "refs": ["--all"]}),
        json!({"kind": "refs", "refs": ["HEAD"]}),
        json!({"kind": "glob", "include": ["--all"]}),
        json!({"kind": "glob", "include": ["refs/heads/[a-z]*"]}),
    ] {
        assert_eq!(
            f.service
                .history(&f.repo, f.query(json!({"scope": scope})))
                .await
                .unwrap_err()
                .code,
            "ARGUMENT"
        );
    }
}

#[tokio::test]
async fn refs_search_matches_all_label_tips_and_keeps_scope_independent() {
    let f = Fixture::new();
    let root = f.commit("root");
    let a = f.detached_commit(Some(&root), "alpha subject");
    let b = f.detached_commit(Some(&root), "beta subject");
    let hidden = f.detached_commit(None, "out of selected scope");
    for (name, oid) in [
        ("refs/heads/match/one", &a),
        ("refs/heads/match/two", &b),
        ("refs/tags/match/also-one", &a),
        ("refs/heads/match/outside", &hidden),
    ] {
        f.git(&["update-ref", name, oid]);
    }
    let _request = f.service.begin_request(REQUEST).unwrap();
    let all = f
        .history(json!({"searchMode": "refs", "search": "match/"}))
        .await;
    assert_eq!(ids(&all), BTreeSet::from([a.clone(), b.clone(), hidden]));
    assert!(!ids(&all).contains(&root)); // No ancestry is added by label search.
    let scoped = f.history(json!({"scope": {"kind": "refs", "refs": ["refs/heads/match/one", "refs/heads/match/two"]},
        "searchMode": "refs", "search": "match/"})).await;
    assert_eq!(ids(&scoped), BTreeSet::from([a.clone(), b]));
    let alpha = scoped
        .commits
        .iter()
        .find(|commit| commit.oid == a)
        .unwrap();
    assert_eq!(
        alpha
            .refs
            .iter()
            .filter(|item| item.name.contains("match/"))
            .count(),
        2
    );
    let empty = f
        .history(json!({"scope": {"kind": "head"}, "searchMode": "refs", "search": "match/"}))
        .await;
    assert!(empty.commits.is_empty());
    let selected_hidden = f.history(json!({"scope": {"kind": "refs", "refs": ["refs/tags/match/also-one"]}, "showTags": false,
        "includeTagOnly": false})).await;
    assert!(ids(&selected_hidden).contains(&a));
    assert!(selected_hidden
        .commits
        .iter()
        .all(|commit| commit.refs.iter().all(|item| item.kind != "tag")));
    let hidden_label_search = f
        .history(
            json!({"scope": {"kind": "refs", "refs": ["refs/heads/match/one"]},
        "showTags": false, "searchMode": "refs", "search": "refs/tags/match/also-one"}),
        )
        .await;
    assert_eq!(ids(&hidden_label_search), BTreeSet::from([a]));
    assert!(hidden_label_search.commits[0]
        .refs
        .iter()
        .all(|item| item.kind != "tag"));
}

#[tokio::test]
async fn tag_only_remote_head_reflog_and_actual_head_ancestry_are_effective() {
    let f = Fixture::new();
    let root = f.commit("root");
    let main = f.commit("main");
    let tag = f.detached_commit(Some(&root), "tag-only");
    let remote = f.detached_commit(Some(&root), "remote-only HEAD");
    f.git(&["tag", "only-tag", &tag]);
    f.git(&["update-ref", "refs/remotes/local/HEAD", &remote]);
    let lost = f.commit("reflog-only");
    f.git(&["reset", "--hard", &main]);
    let _request = f.service.begin_request(REQUEST).unwrap();
    let limited = f
        .history(
            json!({"includeTagOnly": false, "showRemoteHeads": false, "markHeadAncestry": true}),
        )
        .await;
    assert_eq!(ids(&limited), BTreeSet::from([root.clone(), main.clone()]));
    assert!(limited
        .commits
        .iter()
        .all(|commit| commit.in_head == Some(true)));
    let full = f
        .history(json!({"includeTagOnly": true, "showRemoteHeads": true, "markHeadAncestry": true}))
        .await;
    assert_eq!(
        ids(&full),
        BTreeSet::from([root.clone(), main.clone(), tag.clone(), remote])
    );
    assert_eq!(
        full.commits
            .iter()
            .find(|commit| commit.oid == tag)
            .unwrap()
            .in_head,
        Some(false)
    );
    let reflog = f
        .history(json!({"scope": {"kind": "head"}, "includeReflog": true}))
        .await;
    assert!(ids(&reflog).contains(&lost));
    let state = f.service.working_state(&f.repo, REQUEST).await.unwrap();
    assert_eq!(state.head.as_deref(), Some(main.as_str()));
    assert_eq!(state.branch.as_deref(), Some("main"));
    f.git(&["switch", "--quiet", "--detach", &tag]);
    let detached = f.service.working_state(&f.repo, REQUEST).await.unwrap();
    assert_eq!(detached.head.as_deref(), Some(tag.as_str()));
    assert_eq!(detached.branch, None);
    let snapshot = f.service.snapshot(&f.repo, REQUEST).await.unwrap();
    assert_eq!(snapshot.repository.head, detached.head);
    assert_eq!(snapshot.repository.branch, None);
    let repeated = f.service.snapshot(&f.repo, REQUEST).await.unwrap();
    assert_eq!(snapshot.fingerprint, repeated.fingerprint);
    f.write("untracked.txt", "new\n");
    let changed = f.service.snapshot(&f.repo, REQUEST).await.unwrap();
    assert_ne!(snapshot.fingerprint, changed.fingerprint);
}

#[tokio::test]
async fn stash_projection_filters_before_paging_preserves_parents_and_ordinary_refs() {
    let f = Fixture::new();
    f.write("tracked.txt", "base\n");
    let root = f.commit("root");
    f.write("tracked.txt", "staged\n");
    f.git(&["add", "tracked.txt"]);
    f.write("tracked.txt", "unstaged\n");
    f.write("untracked.txt", "untracked\n");
    f.git(&[
        "stash",
        "push",
        "--include-untracked",
        "--message",
        "first stash",
    ]);
    let stash_oid = f.git(&["rev-parse", "stash@{0}"]).trim().to_owned();
    let parents: Vec<String> = f
        .git(&["show", "--format=%P", "--no-patch", &stash_oid])
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    assert_eq!(parents.len(), 3);
    f.write("tracked.txt", "second stash\n");
    f.git(&["stash", "push", "--message", "second stash"]);
    let _request = f.service.begin_request(REQUEST).unwrap();
    let collapsed = f.history(json!({"collapseStashAuxiliary": true})).await;
    assert_eq!(collapsed.commits.len(), 3);
    let node = collapsed
        .commits
        .iter()
        .find(|commit| commit.oid == stash_oid)
        .unwrap();
    assert_eq!(node.parents, parents);
    assert_eq!(node.graph_parents.as_ref().unwrap(), &vec![root.clone()]);
    assert_eq!(node.node_kind.as_deref(), Some("stash"));
    assert!(!ids(&collapsed).contains(&parents[1]));
    assert!(!ids(&collapsed).contains(&parents[2]));
    let mut paged = Vec::new();
    for offset in 0..collapsed.commits.len() {
        let page = f
            .history(json!({"collapseStashAuxiliary": true, "offset": offset, "limit": 1}))
            .await;
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.has_more, offset + 1 < collapsed.commits.len());
        paged.push(page.commits[0].oid.clone());
    }
    assert_eq!(
        paged,
        collapsed
            .commits
            .iter()
            .map(|commit| commit.oid.clone())
            .collect::<Vec<_>>()
    );
    let expanded = f.history(json!({"collapseStashAuxiliary": false})).await;
    assert_eq!(expanded.commits.len(), 6);
    assert!(ids(&expanded).contains(&root)); // Hiding auxiliaries must not exclude their ancestors.
    f.git(&["update-ref", "refs/heads/keep-index", &parents[1]]);
    f.git(&["tag", "keep-untracked", &parents[2]]);
    let protected = f.history(json!({"collapseStashAuxiliary": true})).await;
    assert!(ids(&protected).contains(&parents[1]));
    assert!(ids(&protected).contains(&parents[2]));
    let kept = protected
        .commits
        .iter()
        .find(|commit| commit.oid == stash_oid)
        .unwrap();
    assert_eq!(
        kept.graph_parents.as_ref().unwrap_or(&kept.parents),
        &parents
    );
    let detail = f
        .service
        .stash_detail(&f.repo, "stash@{1}", REQUEST)
        .await
        .unwrap();
    assert_eq!(detail.oid, stash_oid);
    assert_eq!(detail.base, root);
    assert_eq!(detail.index, parents[1]);
    assert_eq!(detail.untracked.as_ref(), Some(&parents[2]));
    assert!(detail.message.contains("first stash"));
    assert!(detail.timestamp > 0);
    assert!(f
        .service
        .stash_detail(&f.repo, "HEAD", REQUEST)
        .await
        .is_err());
    f.git(&["update-ref", "-d", "refs/heads/keep-index"]);
    f.git(&["tag", "--delete", "keep-untracked"]);
    let dangling_child =
        f.detached_commit(Some(&parents[1]), "explicit dangling descendant of index");
    let ordinary_explicit = f
        .history(json!({"revision": dangling_child, "collapseStashAuxiliary": true}))
        .await;
    assert!(ids(&ordinary_explicit).contains(&parents[1]));
    assert!(ids(&ordinary_explicit).contains(&root));
}

#[tokio::test]
async fn tag_detail_is_complete_for_lightweight_annotated_and_raw_signed_tags() {
    let f = Fixture::new();
    let root = f.commit("root");
    f.git(&["tag", "light", &root]);
    f.git(&[
        "tag",
        "--annotate",
        "发布-v1",
        "--message",
        "release subject\n\n完整说明\nsecond paragraph",
        &root,
    ]);
    let signed = format!("object {root}\ntype commit\ntag signed-fixture\ntagger Tagger With Spaces <tagger@example.test> 1704067500 +0530\n\nsigned subject\n\nfull message\n-----BEGIN PGP SIGNATURE-----\nnot-a-valid-signature\n-----END PGP SIGNATURE-----\n");
    let signed_oid = f.input(&["hash-object", "-t", "tag", "-w", "--stdin"], &signed);
    f.git(&["update-ref", "refs/tags/signed-fixture", &signed_oid]);
    f.git(&[
        "config",
        "--local",
        "gpg.program",
        "must-not-launch-a-verifier",
    ]);
    let _request = f.service.begin_request(REQUEST).unwrap();
    let light = f
        .service
        .tag_detail(&f.repo, "light", REQUEST)
        .await
        .unwrap();
    assert!(!light.annotated);
    assert_eq!(light.r#ref, "refs/tags/light");
    assert_eq!(light.oid, root);
    assert_eq!(light.target_oid, root);
    assert_eq!(light.target_type, "commit");
    assert_eq!(light.signature.status, "N");
    assert!(light.tagger.is_empty() && light.timestamp.is_none() && light.message.is_empty());
    let annotated = f
        .service
        .tag_detail(&f.repo, "refs/tags/发布-v1", REQUEST)
        .await
        .unwrap();
    assert!(annotated.annotated);
    assert_eq!(annotated.tagger, "测试 Author");
    assert_eq!(annotated.email, "fixture@example.test");
    assert!(annotated.timestamp.unwrap() > 0);
    assert!(annotated
        .message
        .contains("release subject\n\n完整说明\nsecond paragraph"));
    assert_eq!(annotated.target_oid, root);
    let signed = f
        .service
        .tag_detail(&f.repo, "signed-fixture", REQUEST)
        .await
        .unwrap();
    assert_eq!(signed.oid, signed_oid);
    assert_eq!(signed.tagger, "Tagger With Spaces");
    assert_eq!(signed.timestamp, Some(1704067500));
    assert_eq!(signed.signature.status, "U");
    assert!(signed.signature.signer.is_empty() && signed.signature.key.is_empty());
    assert_eq!(signed.message, "signed subject\n\nfull message\n");
    assert!(f
        .service
        .tag_detail(&f.repo, "refs/heads/main", REQUEST)
        .await
        .is_err());
    let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
    f.git(&["tag", "tree-tag", tree.trim()]);
    let tree_tag = f
        .service
        .tag_detail(&f.repo, "tree-tag", REQUEST)
        .await
        .unwrap();
    assert_eq!(tree_tag.target_type, "tree");
}

#[tokio::test]
async fn containment_checks_actual_head_descendants_tags_remotes_and_every_stash() {
    let f = Fixture::new();
    f.write("tracked.txt", "base\n");
    let root = f.commit("root");
    let child = f.commit("descendant");
    f.git(&["branch", "child", &child]);
    f.git(&["tag", "--annotate", "child-tag", "--message", "tag", &child]);
    f.git(&["update-ref", "refs/remotes/local/child", &child]);
    let unrelated = f.detached_commit(None, "unrelated");
    f.git(&["branch", "unrelated", &unrelated]);
    for message in ["stash older", "stash newest"] {
        f.write("tracked.txt", message);
        f.git(&["stash", "push", "--message", message]);
    }
    let _request = f.service.begin_request(REQUEST).unwrap();
    let contains = f
        .service
        .containment(&f.repo, &root, REQUEST)
        .await
        .unwrap();
    assert!(contains.head);
    let names: BTreeSet<_> = contains
        .refs
        .iter()
        .map(|item| item.full_name.as_str())
        .collect();
    for name in [
        "refs/heads/main",
        "refs/heads/child",
        "refs/tags/child-tag",
        "refs/remotes/local/child",
        "stash@{0}",
        "stash@{1}",
    ] {
        assert!(names.contains(name), "missing {name}");
    }
    assert!(!names.contains("refs/heads/unrelated"));
    f.git(&["switch", "--quiet", "--detach", &unrelated]);
    let detached = f
        .service
        .containment(&f.repo, &root, REQUEST)
        .await
        .unwrap();
    assert!(!detached.head);
    let own = f
        .service
        .containment(&f.repo, &unrelated, REQUEST)
        .await
        .unwrap();
    assert!(own.head);
    let no_refs = f.detached_commit(None, "not referenced anywhere");
    let orphan = f
        .service
        .containment(&f.repo, &no_refs, REQUEST)
        .await
        .unwrap();
    assert!(!orphan.head && orphan.refs.is_empty());
}

#[tokio::test]
async fn unicode_config_subsections_and_readonly_submodule_state_are_supported() {
    let f = Fixture::new();
    f.commit("root");
    f.git(&[
        "config",
        "--local",
        "remote.远端.分组.url",
        "https://example.invalid/never-contact",
    ]);
    f.git(&[
        "config",
        "--local",
        "branch.功能/中文.description",
        "合法 subsection",
    ]);
    let child_path = f.path.join("modules/中文 child");
    fs::create_dir_all(&child_path).unwrap();
    f.git_at(
        &child_path,
        &[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--template",
            f.root.path().join("templates").to_str().unwrap(),
        ],
    );
    f.configure(&child_path);
    fs::write(child_path.join("tracked.txt"), "base\n").unwrap();
    f.git_at(&child_path, &["add", "tracked.txt"]);
    f.git_at(
        &child_path,
        &[
            "commit",
            "--quiet",
            "--no-gpg-sign",
            "--message",
            "child root",
        ],
    );
    let child_root = f
        .git_at(&child_path, &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    f.write(".gitmodules", "[submodule \"模块.中文\"]\n\tpath = modules/中文 child\n\turl = https://example.invalid/no-network\n");
    f.git(&["add", ".gitmodules"]);
    f.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{child_root},modules/中文 child"),
    ]);
    f.git(&[
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "--message",
        "record submodule",
    ]);
    let config_before = fs::read(f.path.join(".git/config")).unwrap();
    let _request = f.service.begin_request(REQUEST).unwrap();
    let config = f.service.repo_config(&f.repo, REQUEST).await.unwrap();
    assert_eq!(config.user_name, "测试 Author");
    let remotes = f.service.remotes(&f.repo, REQUEST).await.unwrap();
    assert!(remotes.iter().any(|remote| remote.name == "远端.分组"));
    let clean = f.service.submodules(&f.repo, REQUEST).await.unwrap();
    assert_eq!(clean.len(), 1);
    assert_eq!(clean[0].name, "模块.中文");
    assert_eq!(clean[0].url, "https://example.invalid/no-network");
    assert!(clean[0].initialized);
    assert_eq!(clean[0].head.as_ref(), Some(&child_root));
    assert_eq!(clean[0].index_oid.as_ref(), Some(&child_root));
    assert!(!clean[0].modified && !clean[0].untracked);
    fs::write(child_path.join("tracked.txt"), "modified\n").unwrap();
    fs::write(child_path.join("untracked.txt"), "untracked\n").unwrap();
    let dirty = f.service.submodules(&f.repo, REQUEST).await.unwrap();
    assert!(dirty[0].modified && dirty[0].untracked);
    let working = f.service.working_state(&f.repo, REQUEST).await.unwrap();
    let submodule = working
        .files
        .iter()
        .find(|file| file.path == "modules/中文 child")
        .unwrap()
        .submodule
        .as_ref()
        .unwrap();
    assert!(!submodule.commit_changed && submodule.modified && submodule.untracked);
    f.git_at(&child_path, &["add", "tracked.txt"]);
    f.clock.set(f.clock.get() + 60);
    f.git_at(
        &child_path,
        &[
            "commit",
            "--quiet",
            "--no-gpg-sign",
            "--message",
            "child changed",
        ],
    );
    let changed = f.service.working_state(&f.repo, REQUEST).await.unwrap();
    assert!(
        changed
            .files
            .iter()
            .find(|file| file.path == "modules/中文 child")
            .unwrap()
            .submodule
            .as_ref()
            .unwrap()
            .commit_changed
    );
    assert_eq!(fs::read(f.path.join(".git/config")).unwrap(), config_before);
    fs::remove_dir_all(&child_path).unwrap();
    fs::create_dir(&child_path).unwrap();
    let absent = f.service.submodules(&f.repo, REQUEST).await.unwrap();
    assert!(!absent[0].initialized);
    assert!(absent[0].head.is_none());
    assert_eq!(absent[0].index_oid.as_ref(), Some(&child_root));
}

#[tokio::test]
async fn unborn_snapshot_has_null_actual_head_and_not_stale_repository_metadata() {
    let f = Fixture::new();
    let _request = f.service.begin_request(REQUEST).unwrap();
    let snapshot = f.service.snapshot(&f.repo, REQUEST).await.unwrap();
    assert_eq!(snapshot.repository.head, None);
    assert_eq!(snapshot.working.head, None);
    assert_eq!(snapshot.repository.branch.as_deref(), Some("main"));
    assert!(snapshot.refs.is_empty());
}

#[tokio::test]
async fn bare_unborn_and_detached_snapshots_query_actual_head_and_branch() {
    let f = Fixture::new();
    let path = f.root.path().join("bare repository.git");
    fs::create_dir(&path).unwrap();
    f.git_at(
        &path,
        &[
            "init",
            "--quiet",
            "--bare",
            "--initial-branch=main",
            "--template",
            f.root.path().join("templates").to_str().unwrap(),
        ],
    );
    f.configure(&path);
    let mut repo = f.repo.clone();
    repo.id = "bare-history-fixture".into();
    repo.path = path.to_string_lossy().into_owned();
    repo.git_dir = repo.path.clone();
    repo.common_dir = repo.path.clone();
    repo.bare = true;
    let _request = f.service.begin_request(REQUEST).unwrap();
    let unborn = f.service.snapshot(&repo, REQUEST).await.unwrap();
    assert_eq!(unborn.repository.head, None);
    assert_eq!(unborn.working.head, None);
    assert_eq!(unborn.repository.branch.as_deref(), Some("main"));
    let tree = f.git_at(&path, &["mktree"]).trim().to_owned();
    let oid = f
        .git_at(
            &path,
            &["commit-tree", &tree, "--no-gpg-sign", "-m", "bare root"],
        )
        .trim()
        .to_owned();
    f.git_at(&path, &["update-ref", "refs/heads/main", &oid]);
    let attached = f.service.snapshot(&repo, REQUEST).await.unwrap();
    assert_eq!(attached.repository.head.as_ref(), Some(&oid));
    assert_eq!(attached.working.branch.as_deref(), Some("main"));
    f.git_at(&path, &["update-ref", "--no-deref", "HEAD", &oid]);
    let detached = f.service.snapshot(&repo, REQUEST).await.unwrap();
    assert_eq!(detached.repository.head.as_ref(), Some(&oid));
    assert_eq!(detached.repository.branch, None);
}
