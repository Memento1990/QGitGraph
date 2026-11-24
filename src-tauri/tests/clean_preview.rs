//! Native clean capabilities exercised only against fresh TempDir worktrees.
//! No developer repository, profile, remote, shell command or arbitrary argv is
//! accepted by the clean API.

use qgitgraph_lib::{
    error::Result,
    git::{sanitize_environment, GitService},
    model::{ActionResult, GitAction, Repository},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    root: PathBuf,
    home: PathBuf,
    service: GitService,
    repo: Repository,
}

fn display(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_owned()
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-clean-preview-")
            .tempdir()
            .unwrap();
        let root = directory.path().join("worktree 中文 空格");
        let home = directory.path().join("isolated home");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let root = fs::canonicalize(root).unwrap();
        let service = GitService::isolated(None, home.clone());
        let mut fixture = Self {
            repo: Repository {
                id: display(&root),
                path: display(&root),
                name: "Clean fixture".into(),
                git_dir: display(&root.join(".git")),
                common_dir: display(&root.join(".git")),
                head: None,
                branch: Some("main".into()),
                trusted: true,
                bare: false,
            },
            _directory: directory,
            root,
            home,
            service,
        };
        fixture.git(&["init", "--quiet", "--initial-branch=main", "--template="]);
        for (key, value) in [
            ("user.name", "Clean Fixture"),
            ("user.email", "clean@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.filemode", "false"),
        ] {
            fixture.git(&["config", "--local", key, value]);
        }
        fixture.write("tracked.txt", b"tracked must survive\n");
        fixture.write(".gitignore", b"*.ignored\nignored-dir/\n");
        fixture.git(&["add", "--", "tracked.txt", ".gitignore"]);
        fixture.git(&["commit", "--quiet", "--message=fixture"]);
        fixture.repo.head = Some(fixture.git(&["rev-parse", "HEAD"]).trim().into());
        fixture
    }

    fn git(&self, args: &[&str]) -> String {
        let mut command = Command::new(self.service.git_path());
        sanitize_environment(&mut command, true, false, Some(&self.home));
        let output = command
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["-c", "core.hooksPath=", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture Git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn bytes(&self, relative: &str) -> Vec<u8> {
        fs::read(self.root.join(relative)).unwrap()
    }

    async fn action(&self, request_id: &str, options: Value) -> Result<ActionResult> {
        let mut value = json!({"kind":"clean", "repoId":self.repo.id, "requestId":request_id});
        value
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let action: GitAction = serde_json::from_value(value).unwrap();
        let _request = self.service.begin_request(request_id)?;
        let _transaction = self
            .service
            .repository_transaction(&self.repo, request_id)
            .await?;
        self.service.action(&self.repo, action).await
    }

    async fn preview(&self, request_id: &str, flags: Value) -> ActionResult {
        let mut options = flags;
        options["mode"] = json!("preview");
        self.action(request_id, options).await.unwrap()
    }

    async fn delete(&self, token: &str) -> Result<ActionResult> {
        self.action(
            "delete",
            json!({"mode":"delete", "force":true, "cleanPreviewToken":token}),
        )
        .await
    }
}

#[tokio::test]
async fn ordinary_preview_is_typed_read_only_and_deletion_is_exact_regular_files() {
    let f = Fixture::new();
    f.write("ordinary.txt", b"reviewed\n");
    f.write("directory/中文.txt", b"nested file\0\xff");
    f.write("--force", b"not an option\n");
    f.write("[literal].txt", b"not a wildcard\n");
    f.write("precious.ignored", b"ignored must survive\n");
    let preview = f.preview("preview", json!({})).await;
    let token = preview.preview_token.as_deref().unwrap();
    assert_eq!(token.len(), 64);
    assert!(!preview.output.contains(token));
    assert!(preview.output.contains("ordinary.txt"));
    assert!(preview.output.contains("[literal].txt"));
    assert!(!preview.output.contains("precious.ignored"));
    assert!(preview.output.contains("Directories"));
    assert_eq!(f.bytes("ordinary.txt"), b"reviewed\n");
    let result = f.delete(token).await.unwrap();
    assert!(result.preview_token.is_none());
    for path in [
        "ordinary.txt",
        "directory/中文.txt",
        "--force",
        "[literal].txt",
    ] {
        assert!(
            !f.root.join(path).exists(),
            "reviewed file was not removed: {path}"
        );
    }
    assert!(
        f.root.join("directory").is_dir(),
        "directories are deliberately preserved"
    );
    assert_eq!(f.bytes("tracked.txt"), b"tracked must survive\n");
    assert_eq!(f.bytes("precious.ignored"), b"ignored must survive\n");
    assert_eq!(
        f.git(&["status", "--porcelain=v1", "--untracked-files=all"]),
        ""
    );
}

#[tokio::test]
async fn new_untracked_file_after_preview_rejects_entire_delete_without_removing_any_file() {
    let f = Fixture::new();
    f.write("directory/reviewed.txt", b"reviewed\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    // Same directory-level git-clean display before and after: only the exact
    // NUL-delimited file set catches this confirmation bypass.
    f.write(
        "directory/new-after-confirmation.txt",
        b"new precious content\n",
    );
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("directory/reviewed.txt"), b"reviewed\n");
    assert_eq!(
        f.bytes("directory/new-after-confirmation.txt"),
        b"new precious content\n"
    );
}

#[tokio::test]
async fn same_length_changed_contents_after_preview_rejects_entire_delete() {
    let f = Fixture::new();
    f.write("first.txt", b"before\n");
    f.write("second.txt", b"stable\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    f.write("first.txt", b"after!\n");
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("first.txt"), b"after!\n");
    assert_eq!(f.bytes("second.txt"), b"stable\n");
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
}

#[tokio::test]
async fn identical_bytes_new_file_identity_after_preview_rejects_delete() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"identical\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    let old = f._directory.path().join("old-file");
    fs::rename(f.root.join("reviewed.txt"), &old).unwrap();
    f.write("reviewed.txt", b"identical\n");
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"identical\n");
    assert_eq!(fs::read(old).unwrap(), b"identical\n");
}

#[tokio::test]
async fn consumed_token_is_rejected_even_when_identical_files_are_recreated() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"same\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    f.delete(&token).await.unwrap();
    f.write("reviewed.txt", b"same\n");
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"same\n");
}

#[tokio::test]
async fn clean_requires_native_preview_token_and_explicit_confirmation() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"preserve\n");
    for token in [
        Value::Null,
        json!(""),
        json!("forged"),
        json!("a".repeat(64)),
    ] {
        let error = f
            .action(
                "delete-invalid",
                json!({"mode":"delete", "force":true, "cleanPreviewToken":token}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "STALE_CLEAN_PREVIEW");
    }
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    assert_eq!(
        f.action(
            "unconfirmed",
            json!({"mode":"delete", "cleanPreviewToken":token})
        )
        .await
        .unwrap_err()
        .code,
        "CONFIRMATION_REQUIRED"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"preserve\n");
}

#[tokio::test]
async fn another_service_session_cannot_redeem_a_token() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"preserve\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    let other = GitService::isolated(None, f.home.clone());
    let action: GitAction = serde_json::from_value(json!({"kind":"clean", "repoId":f.repo.id, "requestId":"other-session", "mode":"delete", "force":true, "cleanPreviewToken":token})).unwrap();
    let _request = other.begin_request("other-session").unwrap();
    let _transaction = other
        .repository_transaction(&f.repo, "other-session")
        .await
        .unwrap();
    assert_eq!(
        other.action(&f.repo, action).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"preserve\n");
}

#[tokio::test]
async fn another_repository_and_common_dir_cannot_redeem_a_token() {
    let f = Fixture::new();
    let other = Fixture::new();
    f.write("reviewed.txt", b"first repository\n");
    other.write("reviewed.txt", b"second repository\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    let action: GitAction = serde_json::from_value(json!({"kind":"clean", "repoId":other.repo.id, "requestId":"other-repository", "mode":"delete", "force":true, "cleanPreviewToken":token})).unwrap();
    let _request = f.service.begin_request("other-repository").unwrap();
    let _transaction = f
        .service
        .repository_transaction(&other.repo, "other-repository")
        .await
        .unwrap();
    assert_eq!(
        f.service
            .action(&other.repo, action)
            .await
            .unwrap_err()
            .code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"first repository\n");
    assert_eq!(other.bytes("reviewed.txt"), b"second repository\n");
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
}

#[tokio::test]
async fn include_flags_are_frozen_and_ignored_only_clean_is_supported() {
    let f = Fixture::new();
    f.write("untracked.txt", b"untracked\n");
    f.write("secret.ignored", b"ignored\n");
    let token = f
        .preview("preview-flags", json!({}))
        .await
        .preview_token
        .unwrap();
    assert_eq!(
        f.action(
            "flags-changed",
            json!({"mode":"delete", "force":true, "includeIgnored":true, "cleanPreviewToken":token})
        )
        .await
        .unwrap_err()
        .code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("untracked.txt"), b"untracked\n");
    assert_eq!(f.bytes("secret.ignored"), b"ignored\n");
    let preview = f
        .preview(
            "ignored-only-preview",
            json!({"includeIgnored":true, "includeUntracked":false}),
        )
        .await;
    assert!(preview.output.contains("secret.ignored"));
    assert!(!preview.output.contains("untracked.txt"));
    f.action("ignored-only-delete", json!({"mode":"delete", "force":true, "includeIgnored":true, "includeUntracked":false, "cleanPreviewToken":preview.preview_token})).await.unwrap();
    assert!(!f.root.join("secret.ignored").exists());
    assert_eq!(f.bytes("untracked.txt"), b"untracked\n");
}

#[tokio::test]
async fn cancelling_finished_preview_request_permanently_invalidates_its_token_only() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"preserve\n");
    let token = f
        .preview("preview-to-cancel", json!({}))
        .await
        .preview_token
        .unwrap();
    let unrelated = f
        .preview("independent-preview", json!({}))
        .await
        .preview_token
        .unwrap();
    f.service.cancel("unrelated-read-request");
    f.service.cancel("preview-to-cancel");
    // Consume the pending-cancel tombstone; the invalid capability stays gone.
    assert_eq!(
        f.service
            .begin_request("preview-to-cancel")
            .err()
            .unwrap()
            .code,
        "CANCELLED"
    );
    drop(f.service.begin_request("preview-to-cancel").unwrap());
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"preserve\n");
    f.delete(&unrelated).await.unwrap();
}

#[tokio::test]
async fn cancel_all_invalidates_completed_preview_tokens() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"preserve\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    f.service.cancel_all();
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"preserve\n");
}

#[tokio::test]
async fn file_becoming_tracked_after_preview_is_not_removed() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"now staged\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    f.git(&["add", "--", "reviewed.txt"]);
    assert_eq!(
        f.delete(&token).await.unwrap_err().code,
        "STALE_CLEAN_PREVIEW"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"now staged\n");
    assert_eq!(f.git(&["show", ":reviewed.txt"]), "now staged\n");
}

#[tokio::test]
async fn nested_repository_empty_directories_and_tracked_files_are_preserved() {
    let f = Fixture::new();
    f.write("ordinary.txt", b"remove only this\n");
    let nested = f.root.join("nested-repository");
    fs::create_dir(&nested).unwrap();
    let mut command = Command::new(f.service.git_path());
    sanitize_environment(&mut command, true, false, Some(&f.home));
    assert!(command
        .current_dir(&nested)
        .args(["init", "--quiet", "--template="])
        .status()
        .unwrap()
        .success());
    f.write("nested-repository/precious.txt", b"nested repository\n");
    fs::create_dir(f.root.join("empty-directory")).unwrap();
    let token = f
        .preview("preview", json!({"includeIgnored":true}))
        .await
        .preview_token
        .unwrap();
    f.action(
        "delete",
        json!({"mode":"delete", "force":true, "includeIgnored":true, "cleanPreviewToken":token}),
    )
    .await
    .unwrap();
    assert_eq!(
        f.bytes("nested-repository/precious.txt"),
        b"nested repository\n"
    );
    assert!(f.root.join("nested-repository/.git").is_dir());
    assert!(f.root.join("empty-directory").is_dir());
    assert_eq!(f.bytes("tracked.txt"), b"tracked must survive\n");
    assert!(!f.root.join("ordinary.txt").exists());
}

#[tokio::test]
async fn replaced_git_administration_rejects_old_preview() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"preserve\n");
    let token = f.preview("preview", json!({})).await.preview_token.unwrap();
    let original = f._directory.path().join("original-git");
    fs::rename(f.root.join(".git"), &original).unwrap();
    f.git(&["init", "--quiet", "--template="]);
    let error = f.delete(&token).await.unwrap_err();
    assert!(matches!(
        error.code.as_str(),
        "AUTHORIZATION_CHANGED" | "STALE_CLEAN_PREVIEW"
    ));
    assert_eq!(f.bytes("reviewed.txt"), b"preserve\n");
}

#[tokio::test]
async fn hard_links_and_over_limit_files_fail_closed_before_any_delete() {
    let f = Fixture::new();
    f.write("reviewed.txt", b"preserve\n");
    fs::hard_link(
        f.root.join("reviewed.txt"),
        f._directory.path().join("external-hard-link"),
    )
    .unwrap();
    assert_eq!(
        f.action("hard-link-preview", json!({"mode":"preview"}))
            .await
            .unwrap_err()
            .code,
        "UNSAFE_CLEAN_PATH"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"preserve\n");
    fs::remove_file(f._directory.path().join("external-hard-link")).unwrap();
    let large = fs::File::create(f.root.join("large.bin")).unwrap();
    large.set_len(16 * 1024 * 1024 + 1).unwrap();
    drop(large);
    assert_eq!(
        f.action("large-preview", json!({"mode":"preview"}))
            .await
            .unwrap_err()
            .code,
        "CLEAN_PREVIEW_LIMIT"
    );
    assert_eq!(f.bytes("reviewed.txt"), b"preserve\n");
}

#[cfg(windows)]
#[tokio::test]
async fn junction_or_reparse_parent_is_never_followed() {
    use std::os::windows::process::CommandExt;
    let f = Fixture::new();
    let outside = f._directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("precious.txt"), b"outside\n").unwrap();
    let junction = f.root.join("junction");
    // A fixed fixture-only OS operation, not an argument accepted by the API.
    let system = PathBuf::from(std::env::var_os("WINDIR").unwrap())
        .join("System32")
        .join("cmd.exe");
    let status = Command::new(system)
        .creation_flags(0x08000000)
        .current_dir(&f.root)
        .args(["/d", "/c", "mklink", "/J", "junction", "..\\outside"])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let result = f
        .action(
            "junction-preview",
            json!({"mode":"preview", "includeIgnored":true}),
        )
        .await;
    if let Ok(preview) = result {
        f.action("junction-delete", json!({"mode":"delete", "force":true, "includeIgnored":true, "cleanPreviewToken":preview.preview_token})).await.unwrap();
    }
    assert_eq!(
        fs::read(outside.join("precious.txt")).unwrap(),
        b"outside\n"
    );
    assert!(fs::symlink_metadata(&junction).is_ok());
    fs::remove_dir(junction).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_and_special_paths_fail_closed() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f._directory.path().join("outside.txt");
    fs::write(&outside, b"outside\n").unwrap();
    symlink(&outside, f.root.join("link.txt")).unwrap();
    assert_eq!(
        f.action("link-preview", json!({"mode":"preview"}))
            .await
            .unwrap_err()
            .code,
        "UNSAFE_CLEAN_PATH"
    );
    assert_eq!(fs::read(outside).unwrap(), b"outside\n");
    fs::remove_file(f.root.join("link.txt")).unwrap();
    f.write("NUL", b"special\n");
    assert_eq!(
        f.action("special-preview", json!({"mode":"preview"}))
            .await
            .unwrap_err()
            .code,
        "UNSAFE_CLEAN_PATH"
    );
}
