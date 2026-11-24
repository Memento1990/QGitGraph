//! Independently implemented Git mutation layer. No shell or user-provided flags.
//!
//! The caller must hold `GitService::transaction(repo.id)` for the whole action
//! (including interactive rebase). `run` must not acquire that mutex again. Each
//! subprocess inherits the runner's cancellation, trust and noninteractive-stdin
//! policy. Git's own index/ref locks are never removed by this module.

#[path = "clean.rs"]
pub(super) mod clean;

use super::GitService;
use crate::{
    error::{AppError, Result},
    model::{ActionResult, GitAction, Repository},
};
use std::{fs, io, path::Path};

const MAX_NAME: usize = 1024;
const MAX_TEXT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Revision {
    Head,
    Ref(String),
    Hash(String),
    Stash(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteLocation {
    local: bool,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("INVALID_ACTION", message)
}

fn required<'a>(value: Option<&'a str>, field: &str) -> Result<&'a str> {
    value
        .filter(|v| !v.is_empty())
        .ok_or_else(|| invalid(format!("{field} is required.")))
}

fn checked_text(value: &str, label: &str, max: usize, multiline: bool) -> Result<()> {
    if value.len() > max
        || value
            .chars()
            .any(|c| c.is_control() && !(multiline && c == '\n'))
    {
        return Err(invalid(format!(
            "{label} contains a control character or is too long."
        )));
    }
    Ok(())
}

fn ref_name(value: &str) -> Result<()> {
    checked_text(value, "Reference", MAX_NAME, false)?;
    if value.is_empty()
        || value == "@"
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value
            .chars()
            .any(|c| c.is_whitespace() || "~^:?*[\\".contains(c))
        || value.split('/').any(|part| {
            part.is_empty() || part.starts_with('.') || part.to_ascii_lowercase().ends_with(".lock")
        })
    {
        return Err(invalid(
            "Invalid Git reference name; options and revision expressions are not accepted.",
        ));
    }
    Ok(())
}

fn branch_name(value: &str) -> Result<String> {
    let name = value.strip_prefix("refs/heads/").unwrap_or(value);
    ref_name(name)?;
    if name == "HEAD" || name.starts_with("refs/") {
        return Err(invalid(
            "Expected a local branch name, not HEAD or another ref namespace.",
        ));
    }
    Ok(name.to_owned())
}

fn tag_name(value: &str) -> Result<String> {
    let name = value.strip_prefix("refs/tags/").unwrap_or(value);
    ref_name(name)?;
    if name == "HEAD" || name.starts_with("refs/") {
        return Err(invalid("Expected a tag name."));
    }
    Ok(name.to_owned())
}

fn remote_name(value: &str) -> Result<String> {
    checked_text(value, "Remote", 128, false)?;
    // Config CLI keys split at the first and last dot; a validated subsection
    // can contain dots, slashes and Unicode without quoting or regex expansion.
    // The complete remote-tracking ref is validated again by Git before use.
    ref_name(value)?;
    if value == "HEAD" || value.contains(['"', '\'']) {
        return Err(invalid(
            "Expected a Git remote subsection/ref name, not HEAD or a quoted config section.",
        ));
    }
    Ok(value.to_owned())
}

fn stash_selector(value: &str) -> Result<String> {
    checked_text(value, "Stash selector", 40, false)?;
    let index = value
        .strip_prefix("stash@{")
        .and_then(|s| s.strip_suffix('}'))
        .ok_or_else(|| invalid("Expected a stash selector such as stash@{0}."))?;
    if index.is_empty()
        || !index.bytes().all(|b| b.is_ascii_digit())
        || index.len() > 10
        || (index.len() > 1 && index.starts_with('0'))
        || index.parse::<u32>().is_err()
    {
        return Err(invalid("Invalid stash index."));
    }
    Ok(value.to_owned())
}

fn revision(value: &str) -> Result<Revision> {
    checked_text(value, "Revision", MAX_NAME, false)?;
    if value == "HEAD" {
        return Ok(Revision::Head);
    }
    if value.starts_with("stash@{") {
        return Ok(Revision::Stash(stash_selector(value)?));
    }
    if (4..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(Revision::Hash(value.to_ascii_lowercase()));
    }
    ref_name(value)?;
    if value.starts_with("refs/") && value.split('/').count() < 3 {
        return Err(invalid("Expected a complete ref name."));
    }
    Ok(Revision::Ref(value.to_owned()))
}

fn is_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_oid(output: &str) -> Result<String> {
    let value = output.trim();
    if !is_oid(value) {
        return Err(AppError::new(
            "GIT_OUTPUT",
            "Git did not return exactly one object ID.",
        ));
    }
    Ok(value.to_ascii_lowercase())
}

fn remote_location(value: &str, trusted: bool) -> Result<RemoteLocation> {
    checked_text(value, "Remote URL", 16 * 1024, false)?;
    if value.is_empty() || value.starts_with('-') || value.trim() != value {
        return Err(invalid(
            "Invalid remote URL; external remote helpers and option-looking URLs are forbidden.",
        ));
    }
    if (!value.contains("://") && !is_local_path(value) && value.contains("::"))
        || value.as_bytes().windows(3).any(|w| {
            w[0] == b'%'
                && u8::from_str_radix(std::str::from_utf8(&w[1..]).unwrap_or(""), 16)
                    .is_ok_and(|b| b < 32 || b == 127)
        })
    {
        return Err(invalid(
            "Remote helpers and percent-encoded control characters are forbidden.",
        ));
    }
    let local = if value.contains("://") {
        let url = url::Url::parse(value).map_err(|_| invalid("Malformed remote URL."))?;
        if url.query().is_some() || url.fragment().is_some() {
            return Err(invalid(
                "Remote URLs may not contain query strings or fragments.",
            ));
        }
        match url.scheme() {
            "https" | "http" | "ssh" | "git" => {
                if url.password().is_some()
                    || matches!(url.scheme(), "https" | "http" | "git")
                        && !url.username().is_empty()
                {
                    return Err(invalid("Remote URLs must not embed passwords or access tokens. Use Git's credential manager or SSH agent instead."));
                }
                let host = url.host_str().unwrap_or("");
                if host.is_empty()
                    || host.starts_with('-')
                    || url.username().starts_with('-')
                    || url
                        .username()
                        .chars()
                        .any(|c| c.is_whitespace() || c.is_control())
                    || value.chars().any(char::is_whitespace)
                {
                    return Err(invalid(
                        "A network remote must have a safe host/user and contain no whitespace.",
                    ));
                }
                false
            }
            "file" => {
                if !url.username().is_empty()
                    || url.password().is_some()
                    || url.port().is_some()
                    || !matches!(url.host_str(), None | Some("") | Some("localhost"))
                    || url.to_file_path().is_err()
                {
                    return Err(invalid("Only a local file URL is allowed; UNC/network file URLs are not supported."));
                }
                true
            }
            _ => {
                return Err(invalid(
                    "Only HTTPS, HTTP, SSH, Git and trusted local file transports are supported.",
                ))
            }
        }
    } else if is_local_path(value) {
        true
    } else if let Some((host, path)) = value.split_once(':') {
        // Strict scp-style SSH, not an arbitrary transport/helper specification.
        if host.is_empty()
            || path.is_empty()
            || host.starts_with('-')
            || host
                .rsplit('@')
                .next()
                .is_some_and(|name| name.is_empty() || name.starts_with('-'))
            || path.starts_with('-')
            || path.starts_with('/') && path.starts_with("//")
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-@".contains(&b))
            || host.matches('@').count() > 1
            || value.chars().any(char::is_whitespace)
            || path.chars().any(|c| "'\"`$;&|<>()\\".contains(c))
        {
            return Err(invalid("Invalid scp-style SSH remote URL."));
        }
        false
    } else {
        return Err(invalid(
            "Use an explicit network URL or an absolute/./../ local repository path.",
        ));
    };
    if local
        && !value.contains("://")
        && (value.starts_with("\\\\")
            || value.starts_with("//")
            || value
                .as_bytes()
                .get(2..)
                .is_some_and(|rest| rest.contains(&b':')))
    {
        return Err(invalid(
            "Use a local filesystem path, not a device path, UNC path or alternate data stream.",
        ));
    }
    if local && !trusted {
        return Err(AppError::new(
            "UNTRUSTED",
            "Local repository transports require repository trust.",
        ));
    }
    Ok(RemoteLocation { local })
}

fn is_local_path(value: &str) -> bool {
    let b = value.as_bytes();
    if value.starts_with("\\\\") || value.starts_with("//") {
        return false;
    }
    value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with(".\\")
        || value.starts_with("..\\")
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'/' | b'\\'))
}

fn words(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_owned()).collect()
}

fn network_prefix(local: bool) -> Vec<String> {
    let mut args = words(&[
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.http.allow=always",
        "-c",
        "protocol.ssh.allow=always",
        "-c",
        "protocol.git.allow=always",
        "-c",
        if local {
            "protocol.file.allow=always"
        } else {
            "protocol.file.allow=never"
        },
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "push.recurseSubmodules=no",
        "-c",
        "fetch.pruneTags=false",
        "-c",
        "push.followTags=false",
    ]);
    // Configured fetch refspecs are ignored by all action-layer fetches, but
    // protocol and tag/prune configuration still needs an explicit policy.
    args.extend(words(&[
        "-c",
        "fetch.prune=false",
        "-c",
        "fetch.pruneTags=false",
    ]));
    args
}

fn redact_network_text(value: &str) -> String {
    // This is display-only redaction, not URL validation. Avoid parsing and
    // re-serializing the entire Git error (which may contain quoted URLs).
    let mut output = value.to_owned();
    for scheme in ["https://", "http://", "ssh://", "git://"] {
        let mut offset = 0;
        while let Some(relative) = output[offset..].to_ascii_lowercase().find(scheme) {
            let start = offset + relative + scheme.len();
            let end = output[start..]
                .find(|c: char| c.is_whitespace() || matches!(c, '/' | '<' | '>'))
                .map(|n| start + n)
                .unwrap_or(output.len());
            if let Some(at) = output[start..end].rfind('@') {
                output.replace_range(start..start + at, "[redacted]");
                offset = start + "[redacted]".len() + 1;
            } else {
                offset = end;
            }
            if offset >= output.len() {
                break;
            }
        }
    }
    // Query strings/fragments are forbidden on preflight. They can still be
    // echoed by a transport error or a server redirect, and may contain tokens.
    output
        .split_inclusive(char::is_whitespace)
        .map(|part| {
            if part.contains("://") {
                if let Some(index) = part.find(['?', '#']) {
                    let trailing = part.trim_end_matches(char::is_whitespace).len();
                    return format!("{}[redacted]{}", &part[..index], &part[trailing..]);
                }
            }
            part.to_owned()
        })
        .collect()
}

fn redacted_error(mut error: AppError) -> AppError {
    error.message = redact_network_text(&error.message);
    error.detail = error.detail.map(|text| redact_network_text(&text));
    error
}

fn url_rewrite_key(key: &str) -> Option<(&str, bool)> {
    let rest = key.strip_prefix("url.")?;
    if let Some(base) = rest.strip_suffix(".insteadof") {
        Some((base, false))
    } else {
        rest.strip_suffix(".pushinsteadof").map(|base| (base, true))
    }
}

fn matches_remote_command_key(key: &[u8], remote: &str) -> bool {
    ["uploadpack", "receivepack", "proxy"]
        .iter()
        .any(|property| key == format!("remote.{remote}.{property}").as_bytes())
}

fn signed(args: &mut Vec<String>, action: &GitAction) {
    if action.sign == Some(true) {
        args.push("--gpg-sign".into());
    } else if action.sign == Some(false) {
        args.push("--no-gpg-sign".into());
    }
}

fn merge_args(action: &GitAction, oid: &str) -> Result<Vec<String>> {
    if action.squash == Some(true) && action.no_fast_forward == Some(true) {
        return Err(invalid(
            "Squash and no-fast-forward are mutually exclusive.",
        ));
    }
    let mut args = words(&[
        "merge",
        "--no-edit",
        "--no-autostash",
        "--no-overwrite-ignore",
    ]);
    if action.squash == Some(true) {
        args.push("--squash".into());
        args.push("--no-commit".into());
    } else {
        // --no-commit alone does not stop a fast-forward. Force a real merge
        // when the caller explicitly asks to review changes before committing.
        if action.no_fast_forward == Some(true) || action.no_commit == Some(true) {
            args.push("--no-ff".into());
        }
        if action.no_commit == Some(true) {
            args.push("--no-commit".into());
        } else {
            args.push("--commit".into());
        }
    }
    signed(&mut args, action);
    if action.squash != Some(true) {
        if let Some(message) = &action.message {
            args.extend(["--message".into(), message.clone()]);
        }
    }
    args.extend(["--".into(), oid.to_owned()]);
    Ok(args)
}

fn rebase_args(action: &GitAction, oid: &str, interactive: bool) -> Vec<String> {
    let mut args = words(&[
        "-c",
        "rebase.autoSquash=false",
        "-c",
        "rebase.instructionFormat=%s",
        "-c",
        "rebase.abbreviateCommands=false",
        "rebase",
        "--no-autostash",
        "--no-update-refs",
        "--no-fork-point",
        "--no-autosquash",
        if action.preserve_merges == Some(true) {
            "--rebase-merges"
        } else {
            "--no-rebase-merges"
        },
    ]);
    if action.ignore_date == Some(true) {
        args.push("--ignore-date".into());
    }
    if interactive {
        args.push("--interactive".into());
    }
    signed(&mut args, action);
    // Rebase's positionals are revisions, not paths; they are already full OIDs.
    args.push(oid.to_owned());
    args
}

fn drop_args(action: &GitAction, parent: &str, target: &str) -> Vec<String> {
    let mut args = rebase_args(action, target, false);
    args.pop();
    args.extend([
        "--onto".into(),
        parent.to_owned(),
        "--reapply-cherry-picks".into(),
        "--empty=keep".into(),
        target.to_owned(),
    ]);
    args
}

fn pick_args(action: &GitAction, oid: &str, parent_count: usize) -> Result<Vec<String>> {
    let mut args = words(&[action.kind.as_str(), "--no-edit"]);
    if parent_count > 1 {
        let n = action.mode.as_deref().and_then(|mode| mode.strip_prefix("mainline:"))
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) && !value.starts_with('0'))
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|n| *n > 0 && *n <= parent_count)
            .ok_or_else(|| AppError::new("MAINLINE_REQUIRED", "A merge commit requires mode=mainline:N, with an explicit parent number within its actual parent count."))?;
        args.extend(["--mainline".into(), n.to_string()]);
    } else if action.mode.is_some() {
        return Err(invalid("Mainline mode is only valid for merge commits."));
    }
    if action.no_commit == Some(true) {
        args.push("--no-commit".into());
    }
    if action.record_origin == Some(true) {
        args.push("-x".into());
    }
    signed(&mut args, action);
    args.extend(["--".into(), oid.to_owned()]);
    Ok(args)
}

fn reset_args(action: &GitAction, oid: &str) -> Result<Vec<String>> {
    let flag = match action.mode.as_deref().unwrap_or("mixed") {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "keep" => "--keep",
        "hard" => {
            if action.force != Some(true) {
                return Err(AppError::new("CONFIRMATION_REQUIRED", "Hard reset can discard tracked and obstructing untracked files; explicit force confirmation is required."));
            }
            "--hard"
        }
        _ => return Err(invalid("Reset mode must be soft, mixed, keep or hard.")),
    };
    Ok(words(&["reset", flag, oid, "--"]))
}

fn clean_args(action: &GitAction) -> Result<Vec<String>> {
    let preview = match action.mode.as_deref() {
        None | Some("delete") => false,
        Some("preview") => true,
        _ => return Err(invalid("Clean mode must be preview or delete.")),
    };
    if !preview && action.force != Some(true) {
        return Err(AppError::new("CONFIRMATION_REQUIRED", "Clean permanently deletes files. Preview first, then explicitly confirm with force=true."));
    }
    // Clean is never executed with force: deletion uses the reviewed, pinned
    // regular-file set from clean.rs rather than a recursive directory pathspec.
    let mut args = words(&["clean", "--dry-run", "-d"]);
    if action.include_ignored == Some(true) {
        args.push(
            if action.include_untracked != Some(false) {
                "-x"
            } else {
                "-X"
            }
            .into(),
        );
    } else if action.include_untracked == Some(false) {
        return Err(invalid(
            "Choose includeUntracked and/or includeIgnored before cleaning.",
        ));
    }
    // No force at all: nested repositories are never recursively removed.
    args.push("--".into());
    Ok(args)
}

fn identity_args(action: &GitAction) -> Result<Vec<Vec<String>>> {
    let global = action.global == Some(true);
    if global && action.mode.as_deref() != Some("confirmed-global") {
        return Err(AppError::new("GLOBAL_CONFIRMATION_REQUIRED", "The UI must explicitly confirm a global identity change, then send mode=confirmed-global."));
    }
    if !global && !matches!(action.mode.as_deref(), None | Some("local")) {
        return Err(invalid("Local identity mode must be local."));
    }
    let mut commands = Vec::new();
    for (key, value) in [
        ("user.name", action.name.as_deref()),
        ("user.email", action.email.as_deref()),
    ] {
        if let Some(value) = value {
            checked_text(value, key, 1024, false)?;
            if value.trim().is_empty() || value.trim() != value || value.contains(['<', '>']) {
                return Err(invalid("Identity values must be nonempty and contain no '<', '>' or surrounding whitespace."));
            }
            commands.push(words(&[
                "config",
                if global { "--global" } else { "--local" },
                "--replace-all",
                "--",
                key,
                value,
            ]));
        }
    }
    if commands.is_empty() {
        return Err(invalid("Provide an identity name and/or email."));
    }
    Ok(commands)
}

fn marker(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::new(
            "OPERATION_STATE",
            format!("Cannot inspect Git operation state: {error}"),
        )),
    }
}

fn operation_on_disk(repo: &Repository) -> Result<Option<Operation>> {
    let dir = Path::new(&repo.git_dir);
    if marker(&dir.join("rebase-merge"))? || marker(&dir.join("rebase-apply"))? {
        return Ok(Some(Operation::Rebase));
    }
    if marker(&dir.join("MERGE_HEAD"))? {
        return Ok(Some(Operation::Merge));
    }
    if marker(&dir.join("CHERRY_PICK_HEAD"))? {
        return Ok(Some(Operation::CherryPick));
    }
    if marker(&dir.join("REVERT_HEAD"))? {
        return Ok(Some(Operation::Revert));
    }
    let todo = dir.join("sequencer").join("todo");
    match fs::read_to_string(&todo) {
        Ok(text) => {
            let line = text
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.starts_with('#'));
            if let Some(line) = line {
                if line.starts_with("pick ") {
                    return Ok(Some(Operation::CherryPick));
                }
                if line.starts_with("revert ") {
                    return Ok(Some(Operation::Revert));
                }
            }
            Err(AppError::new(
                "OPERATION_STATE",
                "An unrecognized Git sequencer is active; inspect it in an external terminal.",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::new(
            "OPERATION_STATE",
            format!("Cannot read Git sequencer state: {error}"),
        )),
    }
}

pub(super) fn ensure_idle(repo: &Repository) -> Result<()> {
    if let Some(operation) = operation_on_disk(repo)? {
        return Err(AppError::new(
            "OPERATION_IN_PROGRESS",
            format!(
                "A {} is in progress. Resolve conflicts, then continue or abort it first.",
                operation.name()
            ),
        ));
    }
    Ok(())
}

fn ensure_worktree(repo: &Repository) -> Result<()> {
    if repo.bare {
        return Err(AppError::new(
            "BARE_REPOSITORY",
            "This operation requires a working tree.",
        ));
    }
    Ok(())
}

fn check_envelope(repo: &Repository, action: &GitAction) -> Result<()> {
    if action.repo_id != repo.id {
        return Err(invalid("The action does not belong to this repository."));
    }
    checked_text(&action.request_id, "Request ID", 128, false)?;
    if action.request_id.is_empty() {
        return Err(invalid("Request ID is required."));
    }
    if !repo.trusted {
        return Err(AppError::new(
            "UNTRUSTED",
            "Trust this repository before performing Git actions.",
        ));
    }
    checked_text(&action.kind, "Action kind", 64, false)?;
    for (label, value) in [
        ("Target", &action.target),
        ("Name", &action.name),
        ("Remote", &action.remote),
        ("Branch", &action.branch),
        ("URL", &action.url),
        ("Email", &action.email),
        ("Mode", &action.mode),
    ] {
        if let Some(value) = value {
            checked_text(value, label, MAX_TEXT, false)?;
        }
    }
    if let Some(message) = &action.message {
        checked_text(message, "Message", MAX_TEXT, true)?;
    }
    if let Some(value) = &action.tag_type {
        checked_text(value, "Tag type", 32, false)?;
    }
    if let Some(value) = &action.squash_message {
        checked_text(value, "Squash message format", 32, false)?;
    }
    validate_action_options(action)?;
    if action.interactive == Some(true) && action.kind != "rebase" {
        return Err(invalid("Interactive mode is only supported for rebase."));
    }
    Ok(())
}

// Reject incompatible options before the first mutation, including before the
// fetch half of a pull or optional-push half of tag creation. An explicit false
// is accepted only on an action that actually understands that option.
fn validate_action_options(action: &GitAction) -> Result<()> {
    let kind = action.kind.as_str();
    for (present, option, allowed) in [
        (
            action.checkout_after.is_some(),
            "checkoutAfter",
            kind == "branch-create",
        ),
        (action.tag_type.is_some(), "tagType", kind == "tag-create"),
        (
            action.push_after.is_some(),
            "pushAfter",
            kind == "tag-create",
        ),
        (
            action.reinstate_index.is_some(),
            "reinstateIndex",
            matches!(kind, "stash-apply" | "stash-pop" | "stash-branch"),
        ),
        (
            action.record_origin.is_some(),
            "recordOrigin",
            kind == "cherry-pick",
        ),
        (
            action.ignore_date.is_some(),
            "ignoreDate",
            matches!(kind, "rebase" | "drop")
                || kind == "pull" && action.mode.as_deref() == Some("rebase"),
        ),
        (
            action.preserve_merges.is_some(),
            "preserveMerges",
            matches!(kind, "rebase" | "drop")
                || kind == "pull" && action.mode.as_deref() == Some("rebase"),
        ),
        (
            action.prune.is_some(),
            "prune",
            matches!(kind, "fetch" | "fetch-into" | "pull"),
        ),
        (
            action.prune_tags.is_some(),
            "pruneTags",
            matches!(kind, "fetch" | "pull"),
        ),
        (
            action.squash_message.is_some(),
            "squashMessage",
            matches!(kind, "merge" | "pull") && action.squash == Some(true),
        ),
        (
            action.sign == Some(true),
            "sign",
            matches!(
                kind,
                "merge"
                    | "rebase"
                    | "cherry-pick"
                    | "revert"
                    | "drop"
                    | "tag-create"
                    | "pull"
                    | "continue"
                    | "commit"
            ),
        ),
        (
            action.no_commit.is_some(),
            "noCommit",
            matches!(kind, "merge" | "cherry-pick" | "revert" | "pull"),
        ),
        (
            action.no_fast_forward.is_some(),
            "noFastForward",
            matches!(kind, "merge" | "pull"),
        ),
        (
            action.squash.is_some(),
            "squash",
            matches!(kind, "merge" | "pull"),
        ),
        (action.set_upstream.is_some(), "setUpstream", kind == "push"),
        (
            action.include_untracked.is_some(),
            "includeUntracked",
            matches!(kind, "stash-save" | "clean"),
        ),
        (
            action.include_ignored.is_some(),
            "includeIgnored",
            matches!(kind, "stash-save" | "clean"),
        ),
        (
            action.clean_preview_token.is_some(),
            "cleanPreviewToken",
            kind == "clean",
        ),
        (action.global.is_some(), "global", kind == "identity"),
        (
            action.interactive.is_some(),
            "interactive",
            kind == "rebase" || action.interactive == Some(false),
        ),
    ] {
        if present && !allowed {
            return Err(invalid(format!(
                "{option} is not supported for this action/option combination."
            )));
        }
    }
    if action.squash == Some(true)
        && action
            .message
            .as_ref()
            .is_some_and(|message| message.trim().is_empty())
    {
        return Err(invalid("Squash message must not be empty."));
    }
    if action.prune_tags == Some(true) && action.prune != Some(true) {
        return Err(invalid("pruneTags=true requires explicit prune=true; Git configuration cannot enable tag deletion implicitly."));
    }
    if let Some(format) = action.squash_message.as_deref() {
        if !matches!(format, "default" | "summary") {
            return Err(invalid("Squash message format must be default or summary."));
        }
        if action.message.is_some() {
            return Err(invalid(
                "Use either an explicit message or squashMessage, not both.",
            ));
        }
    }
    if action.kind == "drop" && action.preserve_merges == Some(true) {
        return Err(AppError::new("DROP_MERGE_UNSUPPORTED", "Automatic drop has no merge-preserving rewrite planner. Use a reviewed interactive rebase with preserveMerges=true; root/merge commits are not automatically removed."));
    }
    if (action.kind == "rebase"
        || action.kind == "pull" && action.mode.as_deref() == Some("rebase"))
        && (action.no_commit == Some(true)
            || action.squash == Some(true)
            || action.no_fast_forward == Some(true)
            || action.message.is_some())
    {
        return Err(invalid("Rebase cannot combine merge/no-commit/message options; use a reviewed interactive rebase for todo editing."));
    }
    if action.record_origin == Some(true) && action.no_commit == Some(true) {
        return Err(invalid("recordOrigin requires cherry-pick to create a commit; it cannot be combined with noCommit."));
    }
    if action.push_after == Some(false) && action.remote.is_some() && kind == "tag-create" {
        return Err(invalid("A remote on tag creation requires pushAfter=true."));
    }
    Ok(())
}

impl GitService {
    async fn action_read(
        &self,
        repo: &Repository,
        action: &GitAction,
        args: Vec<String>,
    ) -> Result<String> {
        self.run(repo, &action.request_id, args, false)
            .await
            .map_err(redacted_error)
    }

    pub(super) async fn action_write(
        &self,
        repo: &Repository,
        action: &GitAction,
        args: Vec<String>,
    ) -> Result<String> {
        self.run(repo, &action.request_id, args, true)
            .await
            .map(|output| redact_network_text(&output))
            .map_err(redacted_error)
    }

    async fn action_ref_exists(
        &self,
        repo: &Repository,
        action: &GitAction,
        full: &str,
    ) -> Result<bool> {
        ref_name(full)?;
        let output = self
            .action_read(
                repo,
                action,
                words(&["for-each-ref", "--format=%(refname)", "--", full]),
            )
            .await?;
        Ok(output.lines().any(|line| line == full))
    }

    async fn action_resolve(
        &self,
        repo: &Repository,
        action: &GitAction,
        value: &str,
    ) -> Result<String> {
        let expression = match revision(value)? {
            Revision::Head => "HEAD".to_owned(),
            Revision::Hash(hash) => hash,
            Revision::Stash(selector) => selector,
            Revision::Ref(name) if name.starts_with("refs/") => name,
            Revision::Ref(name) => {
                let mut found = Vec::new();
                for candidate in [
                    format!("refs/heads/{name}"),
                    format!("refs/tags/{name}"),
                    format!("refs/remotes/{name}"),
                ] {
                    if self.action_ref_exists(repo, action, &candidate).await? {
                        found.push(candidate);
                    }
                }
                if found.len() != 1 {
                    return Err(AppError::new(if found.is_empty() { "UNKNOWN_REVISION" } else { "AMBIGUOUS_REVISION" },
                        "Revision must name exactly one branch, tag or remote ref; use a full ref to disambiguate."));
                }
                found.remove(0)
            }
        };
        // The sole accepted revision operator is generated here, after grammar
        // validation. --end-of-options prevents even future parser ambiguity.
        let output = self
            .action_read(
                repo,
                action,
                words(&[
                    "rev-parse",
                    "--verify",
                    "--end-of-options",
                    &format!("{expression}^{{commit}}"),
                ]),
            )
            .await?;
        let oid = parse_oid(&output)?;
        if let Revision::Hash(hash) = revision(value)? {
            if !oid.starts_with(&hash) {
                return Err(AppError::new(
                    "UNKNOWN_REVISION",
                    "The hexadecimal revision did not resolve to a matching commit object ID.",
                ));
            }
        }
        Ok(oid)
    }

    pub(super) async fn action_head_branch(
        &self,
        repo: &Repository,
        action: &GitAction,
    ) -> Result<String> {
        let output = self
            .action_read(repo, action, words(&["symbolic-ref", "--quiet", "HEAD"]))
            .await?;
        let full = output.trim();
        let short = full.strip_prefix("refs/heads/").ok_or_else(|| {
            invalid("This action requires a checked-out local branch, not detached HEAD.")
        })?;
        branch_name(short)
    }

    async fn action_clean_worktree(&self, repo: &Repository, action: &GitAction) -> Result<()> {
        ensure_worktree(repo)?;
        let status = self.working_state(repo, &action.request_id).await?;
        if !status.files.is_empty() {
            return Err(AppError::new("DIRTY_WORKTREE", "Commit, stash or otherwise preserve staged, unstaged and untracked changes first. No automatic stashing or discarding was performed."));
        }
        Ok(())
    }

    async fn action_parents(
        &self,
        repo: &Repository,
        action: &GitAction,
        oid: &str,
    ) -> Result<Vec<String>> {
        let output = self
            .action_read(
                repo,
                action,
                words(&["rev-list", "--parents", "--max-count=1", oid, "--"]),
            )
            .await?;
        let mut fields = output.split_whitespace();
        if fields.next() != Some(oid) {
            return Err(AppError::new("GIT_OUTPUT", "Cannot read commit parents."));
        }
        let parents: Vec<String> = fields.map(str::to_owned).collect();
        if !parents.iter().all(|p| is_oid(p)) {
            return Err(AppError::new("GIT_OUTPUT", "Invalid commit parent ID."));
        }
        Ok(parents)
    }

    async fn action_remote(
        &self,
        repo: &Repository,
        action: &GitAction,
        push: bool,
    ) -> Result<(String, bool)> {
        self.action_remote_named(
            repo,
            action,
            action.remote.as_deref().unwrap_or("origin"),
            push,
        )
        .await
    }

    pub(super) async fn action_remote_named(
        &self,
        repo: &Repository,
        action: &GitAction,
        name: &str,
        push: bool,
    ) -> Result<(String, bool)> {
        let remote = remote_name(name)?;
        self.action_validate_remote_name(repo, action, &remote)
            .await?;
        let listing = self.action_read(repo, action, words(&["remote"])).await?;
        if !listing.lines().any(|v| v == remote) {
            return Err(invalid("The selected remote does not exist."));
        }
        let config = self
            .run_bytes(
                repo,
                &action.request_id,
                words(&["config", "--null", "--list"]),
                false,
            )
            .await?;
        let mut raw_urls = Vec::new();
        let mut rewrites = Vec::new();
        for record in config.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let boundary = record.iter().position(|byte| *byte == b'\n');
            let (key, value) = match boundary {
                Some(index) => (&record[..index], &record[index + 1..]),
                None => (record, &[][..]),
            };
            let source_url_key = format!("remote.{remote}.url");
            let push_url_key = format!("remote.{remote}.pushurl");
            if key == source_url_key.as_bytes() || push && key == push_url_key.as_bytes() {
                let value = std::str::from_utf8(value)
                    .map_err(|_| invalid("A remote URL is not valid UTF-8."))?;
                // Validate the NUL-delimited source, not only get-url's line
                // display, so an embedded newline cannot hide a second URL.
                remote_location(value, repo.trusted)?;
                raw_urls.push(value.to_owned());
            }
            if let Ok(key) = std::str::from_utf8(key) {
                if let Some((base, push_only)) = url_rewrite_key(key) {
                    if !push_only || push {
                        let prefix = std::str::from_utf8(value)
                            .map_err(|_| invalid("A URL rewrite prefix is not valid UTF-8."))?;
                        rewrites.push((base.to_owned(), prefix.to_owned()));
                    }
                }
            }
            if key == format!("remote.{remote}.vcs").as_bytes() {
                return Err(invalid("This remote selects an external VCS helper. Only direct Git transports are supported."));
            }
            // get-url expands URLs for inspection but does not expose proxy or
            // upload/receive-pack overrides. Avoid handing those executable
            // knobs to a transport despite repository trust.
            if matches_remote_command_key(key, &remote) && !value.is_empty() {
                return Err(invalid("This remote overrides its transport command/proxy. Remove the override before using network actions; no helper was run."));
            }
        }
        for value in &raw_urls {
            for (base, prefix) in &rewrites {
                if let Some(suffix) = value.strip_prefix(prefix) {
                    remote_location(&format!("{base}{suffix}"), repo.trusted)?;
                }
            }
        }
        let mut args = words(&["remote", "get-url", "--all"]);
        if push {
            args.push("--push".into());
        }
        args.extend(["--".into(), remote.clone()]);
        // get-url expands url.*.insteadOf/pushInsteadOf. Validating just the URL
        // supplied to remote-add would leave an external-helper rewrite bypass.
        let urls = self.action_read(repo, action, args).await?;
        let mut any = false;
        let mut local = false;
        for value in urls.lines() {
            let value = value.strip_suffix('\r').unwrap_or(value);
            if value.is_empty() {
                continue;
            }
            any = true;
            local |= remote_location(value, repo.trusted)?.local;
        }
        if !any {
            return Err(invalid("The selected remote has no URL."));
        }
        Ok((remote, local))
    }

    /// Returns safe argv for a trusted external console, never a shell string.
    /// The caller holds the repository transaction until that process exits.
    pub async fn interactive_rebase_args(
        &self,
        repo: &Repository,
        action: &GitAction,
    ) -> Result<Vec<String>> {
        let _request = self.request_scope(&action.request_id)?;
        self.check_repository_authorization(repo, &action.request_id, true)?;
        check_envelope(repo, action)?;
        if action.kind != "rebase" || action.interactive != Some(true) {
            return Err(invalid("Expected an interactive rebase action."));
        }
        if action.no_commit == Some(true)
            || action.squash == Some(true)
            || action.no_fast_forward == Some(true)
        {
            return Err(invalid("Rebase does not accept merge/no-commit flags; edit the interactive todo list instead."));
        }
        ensure_idle(repo)?;
        self.action_head_branch(repo, action).await?;
        self.action_clean_worktree(repo, action).await?;
        let oid = self
            .action_resolve(
                repo,
                action,
                required(action.target.as_deref(), "Rebase target")?,
            )
            .await?;
        Ok(rebase_args(action, &oid, true))
    }

    pub async fn action(&self, repo: &Repository, action: GitAction) -> Result<ActionResult> {
        let _request = self.request_scope(&action.request_id)?;
        self.check_repository_authorization(repo, &action.request_id, true)?;
        check_envelope(repo, &action)?;
        if action.kind == "clean" {
            return self.clean_action(repo, &action).await;
        }
        if action.interactive == Some(true) {
            self.interactive_rebase_args(repo, &action).await?;
            return Err(AppError::new("INTERACTIVE_REBASE_REQUIRED", "Interactive rebase must run in the application's external console using interactive_rebase_args, not a background editor."));
        }
        let output = self.perform_action(repo, &action).await?;
        let operation = operation_on_disk(repo)?.map(|state| state.name().to_owned());
        Ok(ActionResult {
            output,
            operation,
            session_id: None,
            status: Some("completed".into()),
            preview_token: None,
        })
    }

    async fn perform_action(&self, repo: &Repository, action: &GitAction) -> Result<String> {
        match action.kind.as_str() {
            "branch-create" => {
                let name = branch_name(required(
                    action.name.as_deref().or(action.branch.as_deref()),
                    "New branch name",
                )?)?;
                let oid = self
                    .action_resolve(repo, action, action.target.as_deref().unwrap_or("HEAD"))
                    .await?;
                if action.force == Some(true) {
                    return Err(invalid("Branch creation never overwrites an existing branch; use reset explicitly."));
                }
                if action.checkout_after == Some(true) {
                    ensure_idle(repo)?;
                    ensure_worktree(repo)?;
                }
                let mut output = self
                    .action_write(
                        repo,
                        action,
                        words(&["branch", "--no-track", "--", &name, &oid]),
                    )
                    .await?;
                if action.checkout_after == Some(true) {
                    let switched = self.action_write(repo, action, switch_branch_args(&name)).await
                        .map_err(|error| partial_failure(error, format!("Branch '{name}' was created, but checkout failed. The branch was kept and no forced checkout or rollback was attempted.")))?;
                    append_output(&mut output, switched);
                }
                Ok(output)
            }
            "branch-rename" => {
                let old = branch_name(required(
                    action.target.as_deref().or(action.branch.as_deref()),
                    "Old branch name",
                )?)?;
                let new = branch_name(required(action.name.as_deref(), "New branch name")?)?;
                ensure_idle(repo)?;
                self.action_write(
                    repo,
                    action,
                    words(&[
                        "branch",
                        if action.force == Some(true) {
                            "-M"
                        } else {
                            "-m"
                        },
                        "--",
                        &old,
                        &new,
                    ]),
                )
                .await
            }
            "branch-delete" => {
                let name = branch_name(required(
                    action.target.as_deref().or(action.branch.as_deref()),
                    "Branch name",
                )?)?;
                self.action_write(
                    repo,
                    action,
                    words(&[
                        "branch",
                        if action.force == Some(true) {
                            "-D"
                        } else {
                            "-d"
                        },
                        "--",
                        &name,
                    ]),
                )
                .await
            }
            "checkout" => {
                ensure_idle(repo)?;
                ensure_worktree(repo)?;
                if action.force == Some(true) {
                    return Err(invalid("Forced checkout is not exposed because it can discard work. Stash or use a separately confirmed hard reset first."));
                }
                let target = required(action.target.as_deref(), "Checkout target")?;
                let oid = self.action_resolve(repo, action, target).await?;
                let local = match revision(target)? {
                    Revision::Ref(name) if name.starts_with("refs/heads/") => {
                        Some(branch_name(&name)?)
                    }
                    Revision::Ref(name) if !name.starts_with("refs/") => {
                        if self
                            .action_ref_exists(repo, action, &format!("refs/heads/{name}"))
                            .await?
                        {
                            Some(branch_name(&name)?)
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                if let Some(name) = local {
                    self.action_write(
                        repo,
                        action,
                        words(&[
                            "switch",
                            "--no-guess",
                            "--no-recurse-submodules",
                            "--no-overwrite-ignore",
                            "--",
                            &name,
                        ]),
                    )
                    .await
                } else {
                    self.action_write(
                        repo,
                        action,
                        words(&[
                            "switch",
                            "--detach",
                            "--no-guess",
                            "--no-recurse-submodules",
                            "--no-overwrite-ignore",
                            "--",
                            &oid,
                        ]),
                    )
                    .await
                }
            }
            "checkout-remote" => self.perform_remote_checkout(repo, action).await,
            "remote-branch-delete" => self.perform_remote_branch_delete(repo, action).await,
            "fetch-into" => self.perform_fetch_into(repo, action).await,
            "merge" => {
                ensure_idle(repo)?;
                self.action_clean_worktree(repo, action).await?;
                let oid = self
                    .action_resolve(
                        repo,
                        action,
                        required(action.target.as_deref(), "Merge target")?,
                    )
                    .await?;
                let output = self
                    .action_write(repo, action, merge_args(action, &oid)?)
                    .await?;
                self.action_squash_message(repo, action, &oid).await?;
                Ok(follow_up_note(
                    output,
                    action.no_commit == Some(true) || action.squash == Some(true),
                ))
            }
            "rebase" => {
                ensure_idle(repo)?;
                if action.no_commit == Some(true)
                    || action.squash == Some(true)
                    || action.no_fast_forward == Some(true)
                {
                    return Err(invalid("Noninteractive rebase does not support merge/no-commit flags. Use interactive rebase for todo editing."));
                }
                self.action_head_branch(repo, action).await?;
                self.action_clean_worktree(repo, action).await?;
                let oid = self
                    .action_resolve(
                        repo,
                        action,
                        required(action.target.as_deref(), "Rebase target")?,
                    )
                    .await?;
                self.action_write(repo, action, rebase_args(action, &oid, false))
                    .await
            }
            "cherry-pick" | "revert" => {
                ensure_idle(repo)?;
                self.action_clean_worktree(repo, action).await?;
                let oid = self
                    .action_resolve(repo, action, required(action.target.as_deref(), "Commit")?)
                    .await?;
                let parents = self.action_parents(repo, action, &oid).await?;
                let args = pick_args(action, &oid, parents.len())?;
                let output = self.action_write(repo, action, args).await?;
                Ok(follow_up_note(output, action.no_commit == Some(true)))
            }
            "drop" => {
                ensure_idle(repo)?;
                self.action_head_branch(repo, action).await?;
                self.action_clean_worktree(repo, action).await?;
                let oid = self
                    .action_resolve(
                        repo,
                        action,
                        required(action.target.as_deref(), "Commit to drop")?,
                    )
                    .await?;
                let parents = self.action_parents(repo, action, &oid).await?;
                if parents.is_empty() {
                    return Err(AppError::new("DROP_ROOT_UNSUPPORTED", "Dropping a root commit requires an explicitly reviewed interactive history rewrite and is not supported here."));
                }
                if parents.len() != 1 {
                    return Err(AppError::new(
                        "DROP_MERGE_UNSUPPORTED",
                        "Automatic drop has no merge-preserving planner. A merge commit requires an explicitly reviewed interactive rebase with preserveMerges=true; no commit was removed.",
                    ));
                }
                let head = self.action_resolve(repo, action, "HEAD").await?;
                let bases = self
                    .action_read(repo, action, words(&["merge-base", "--all", &oid, &head]))
                    .await?;
                if !bases.lines().any(|base| base == oid) {
                    return Err(AppError::new(
                        "DROP_NOT_ANCESTOR",
                        "Only an ancestor of the currently checked-out branch may be dropped.",
                    ));
                }
                let range = format!("{oid}..{head}");
                let merges = self
                    .action_read(
                        repo,
                        action,
                        words(&["rev-list", "--merges", "--max-count=1", &range, "--"]),
                    )
                    .await?;
                if !merges.trim().is_empty() {
                    return Err(AppError::new("DROP_MERGE_UNSUPPORTED", "The rewritten suffix contains a merge; refusing to silently flatten history. Use interactive rebase --rebase-merges in a terminal."));
                }
                // Deliberately no [branch] positional: an OID there detaches HEAD
                // instead of updating the checked-out branch.
                self.action_write(repo, action, drop_args(action, &parents[0], &oid))
                    .await
            }
            "reset" => {
                ensure_idle(repo)?;
                ensure_worktree(repo)?;
                let oid = self
                    .action_resolve(
                        repo,
                        action,
                        required(action.target.as_deref(), "Reset target")?,
                    )
                    .await?;
                self.action_write(repo, action, reset_args(action, &oid)?)
                    .await
            }
            "tag-create" => self.perform_tag_create(repo, action).await,
            "tag-delete" => {
                let name = tag_name(required(
                    action.target.as_deref().or(action.name.as_deref()),
                    "Tag name",
                )?)?;
                self.action_write(repo, action, words(&["tag", "--delete", "--", &name]))
                    .await
            }
            "tag-push" => {
                let name = tag_name(required(
                    action.target.as_deref().or(action.name.as_deref()),
                    "Tag name",
                )?)?;
                self.perform_tag_push(repo, action, &name).await
            }
            "stash-save" => {
                ensure_idle(repo)?;
                ensure_worktree(repo)?;
                let mut args = words(&["stash", "push"]);
                if action.include_ignored == Some(true) {
                    args.push("--all".into());
                } else if action.include_untracked == Some(true) {
                    args.push("--include-untracked".into());
                }
                if let Some(message) = &action.message {
                    args.extend(["--message".into(), message.clone()]);
                }
                args.push("--".into());
                self.action_write(repo, action, args).await
            }
            "stash-apply" | "stash-pop" | "stash-drop" | "stash-branch" => {
                self.perform_stash(repo, action).await
            }
            "fetch" | "pull" | "push" | "prune" => self.perform_network(repo, action).await,
            "remote-add" | "remote-edit" | "remote-remove" => {
                self.perform_remote_edit(repo, action).await
            }
            "set-upstream" => {
                let (remote, _) = self.action_remote(repo, action, false).await?;
                let local = match action.branch.as_deref() {
                    Some(branch) => branch_name(branch)?,
                    None => self.action_head_branch(repo, action).await?,
                };
                let target = required(action.target.as_deref(), "Upstream branch")?;
                let short = if let Some(full) = target.strip_prefix("refs/remotes/") {
                    full.strip_prefix(&format!("{remote}/"))
                        .ok_or_else(|| invalid("Upstream ref belongs to a different remote."))?
                        .to_owned()
                } else {
                    branch_name(target)?
                };
                let upstream = format!("refs/remotes/{remote}/{short}");
                if !self.action_ref_exists(repo, action, &upstream).await? {
                    return Err(invalid("Fetch the selected upstream branch first."));
                }
                self.action_write(
                    repo,
                    action,
                    words(&["branch", "--set-upstream-to", &upstream, "--", &local]),
                )
                .await
            }
            "clean" => Err(invalid(
                "Clean requires the native one-shot preview workflow.",
            )),
            "continue" | "abort" => self.perform_recovery(repo, action).await,
            "commit" => self.perform_follow_up_commit(repo, action).await,
            "identity" => {
                let commands = identity_args(action)?;
                let mut output = String::new();
                for args in commands {
                    append_output(&mut output, self.action_write(repo, action, args).await?);
                }
                if output.is_empty() {
                    output = "Git identity updated.".into();
                }
                Ok(output)
            }
            _ => Err(AppError::new(
                "UNSUPPORTED_ACTION",
                "Unknown Git action. No command was run.",
            )),
        }
    }

    async fn action_squash_message(
        &self,
        repo: &Repository,
        action: &GitAction,
        oid: &str,
    ) -> Result<()> {
        if action.squash != Some(true)
            || action.message.is_none() && action.squash_message.as_deref() != Some("summary")
        {
            return Ok(());
        }
        let path = Path::new(&repo.git_dir).join("SQUASH_MSG");
        // An already-up-to-date merge produces no message. Never create a
        // misleading operation marker when Git did not actually squash.
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(AppError::io(error)),
        };
        if !metadata.file_type().is_file() {
            return Err(AppError::new("OPERATION_STATE", "The squash applied, but SQUASH_MSG is not a regular file; refusing to follow a link. Inspect the preserved index before committing."));
        }
        let message = if let Some(message) = &action.message {
            if message.trim().is_empty() {
                return Err(invalid("Squash message must not be empty."));
            }
            format!("{message}\n")
        } else {
            let subjects = self
                .action_read(
                    repo,
                    action,
                    words(&[
                        "log",
                        "--format=- %s",
                        "--reverse",
                        "--max-count=1000",
                        oid,
                        "--not",
                        "HEAD",
                        "--",
                    ]),
                )
                .await?;
            if subjects.len() > MAX_TEXT {
                return Err(AppError::new("MESSAGE_LIMIT", "The squash applied, but the summary exceeds the message limit. Git's original SQUASH_MSG and the staged changes were retained."));
            }
            format!("Squash summary\n\n{}\n", subjects.trim_end())
        };
        self.with_repository_authorization(repo, &action.request_id, true, || {
            fs::write(&path, message).map_err(|error| AppError::new("IO", format!("The squash applied, but its message could not be written: {error}. Staged changes and Git's recovery state were retained.")))
        })
    }

    async fn action_config_bool(
        &self,
        repo: &Repository,
        action: &GitAction,
        key: &str,
    ) -> Result<bool> {
        // --default avoids treating a missing key as a Git failure, while Git
        // itself parses all accepted boolean spellings and precedence rules.
        let output = self
            .action_read(
                repo,
                action,
                words(&["config", "--type=bool", "--default=false", "--get", key]),
            )
            .await?;
        match output.trim() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(AppError::new(
                "GIT_OUTPUT",
                "Git returned an invalid boolean configuration value.",
            )),
        }
    }

    async fn perform_tag_create(&self, repo: &Repository, action: &GitAction) -> Result<String> {
        if action.mode.is_some() || action.set_upstream == Some(true) {
            return Err(invalid(
                "Tag creation does not accept a mode or setUpstream.",
            ));
        }
        if action.remote.is_some() && action.push_after != Some(true) {
            return Err(invalid("A remote on tag creation requires pushAfter=true."));
        }
        let name = tag_name(required(action.name.as_deref(), "Tag name")?)?;
        let oid = self
            .action_resolve(repo, action, action.target.as_deref().unwrap_or("HEAD"))
            .await?;
        let git_signs_tags = if action.sign.is_none() {
            self.action_config_bool(repo, action, "tag.gpgSign").await?
        } else {
            false
        };
        let args = tag_create_args(action, &name, &oid, git_signs_tags)?;
        // Validate every push URL/helper before creating a local tag. Network
        // failures after creation are still possible and are reported as partial.
        let push = if action.push_after == Some(true) {
            Some(self.action_remote(repo, action, true).await?)
        } else {
            None
        };
        let full = format!("refs/tags/{name}");
        // A forced tag push needs the pre-creation ref object ID; annotated tag
        // objects must not be peeled to their commit for lease comparison.
        let lease = if push.is_some() && action.force == Some(true) {
            self.action_ref_oid(repo, action, &full)
                .await?
                .map(|old| format!("--force-with-lease={full}:{old}"))
        } else {
            None
        };
        let mut output = self.action_write(repo, action, args).await?;
        if let Some((remote, local)) = push {
            let pushed = self.action_write(repo, action, push_args(&remote, local, &format!("{full}:{full}"), lease.as_deref(), false)).await
                .map_err(|error| partial_failure(error, format!("Tag '{name}' was created locally, but its push failed. The local tag was kept; inspect the remote before retrying.")))?;
            append_output(&mut output, pushed);
        }
        Ok(output)
    }

    async fn perform_tag_push(
        &self,
        repo: &Repository,
        action: &GitAction,
        name: &str,
    ) -> Result<String> {
        if action.mode.is_some() || action.set_upstream == Some(true) {
            return Err(invalid("Tag push does not accept a mode or setUpstream."));
        }
        let full = format!("refs/tags/{name}");
        if !self.action_ref_exists(repo, action, &full).await? {
            return Err(invalid("The selected tag does not exist."));
        }
        let (remote, local) = self.action_remote(repo, action, true).await?;
        let lease = if action.force == Some(true) {
            Some(
                self.action_remote_ref_lease(repo, action, &full, None)
                    .await?,
            )
        } else {
            None
        };
        self.action_write(
            repo,
            action,
            push_args(
                &remote,
                local,
                &format!("{full}:{full}"),
                lease.as_deref(),
                false,
            ),
        )
        .await
    }

    async fn action_validate_remote_name(
        &self,
        repo: &Repository,
        action: &GitAction,
        remote: &str,
    ) -> Result<()> {
        remote_name(remote)?;
        self.action_read(
            repo,
            action,
            words(&["check-ref-format", "--branch", remote]),
        )
        .await?;
        self.action_read(
            repo,
            action,
            words(&[
                "check-ref-format",
                &format!("refs/remotes/{remote}/__qgitgraph_validation__"),
            ]),
        )
        .await?;
        Ok(())
    }

    async fn action_ref_oid(
        &self,
        repo: &Repository,
        action: &GitAction,
        full: &str,
    ) -> Result<Option<String>> {
        if !self.action_ref_exists(repo, action, full).await? {
            return Ok(None);
        }
        let output = self
            .action_read(
                repo,
                action,
                words(&["rev-parse", "--verify", "--end-of-options", full]),
            )
            .await?;
        Ok(Some(parse_oid(&output)?))
    }

    async fn action_ref_is_symbolic(
        &self,
        repo: &Repository,
        action: &GitAction,
        full: &str,
    ) -> Result<bool> {
        let output = self
            .action_read(
                repo,
                action,
                words(&[
                    "for-each-ref",
                    "--format=%(refname)%00%(symref)",
                    "--",
                    full,
                ]),
            )
            .await?;
        Ok(output.lines().any(|line| {
            line.split_once('\0')
                .is_some_and(|(name, target)| name == full && !target.is_empty())
        }))
    }

    async fn action_remote_ref_lease(
        &self,
        repo: &Repository,
        action: &GitAction,
        full: &str,
        tracking: Option<&str>,
    ) -> Result<String> {
        // Lease expectations must come from already observed local state, never
        // a just-in-time ls-remote (which would silently bless a stale UI).
        let expected = match tracking {
            Some(tracking) => self.action_ref_oid(repo, action, tracking).await?,
            None => self.action_ref_oid(repo, action, full).await?,
        }.ok_or_else(|| AppError::new("LEASE_REQUIRED", "Fetch and review the selected remote ref before forcing this update/deletion. No unleased force was attempted."))?;
        Ok(format!("--force-with-lease={full}:{expected}"))
    }

    async fn action_fetch_remote(
        &self,
        repo: &Repository,
        action: &GitAction,
        remote: &str,
    ) -> Result<(String, bool)> {
        // Fetch always uses generated refspecs and --refmap= rather than trusting
        // remote.<name>.fetch to select arbitrary writable namespaces.
        self.action_remote_named(repo, action, remote, false).await
    }

    async fn perform_remote_checkout(
        &self,
        repo: &Repository,
        action: &GitAction,
    ) -> Result<String> {
        ensure_idle(repo)?;
        ensure_worktree(repo)?;
        if action.force == Some(true) {
            return Err(invalid(
                "Remote checkout never overwrites a local branch or discards work.",
            ));
        }
        let remote = remote_name(required(action.remote.as_deref(), "Remote")?)?;
        self.action_validate_remote_name(repo, action, &remote)
            .await?;
        let names = self.action_read(repo, action, words(&["remote"])).await?;
        if !names.lines().any(|name| name == remote) {
            return Err(invalid("The selected remote does not exist."));
        }
        let source = remote_branch_name(
            required(action.target.as_deref(), "Remote branch")?,
            &remote,
        )?;
        let local = branch_name(
            action
                .name
                .as_deref()
                .or(action.branch.as_deref())
                .unwrap_or(&source),
        )?;
        let upstream = format!("refs/remotes/{remote}/{source}");
        if !self.action_ref_exists(repo, action, &upstream).await? {
            return Err(invalid(
                "Fetch the selected remote branch before checking it out.",
            ));
        }
        if self.action_ref_is_symbolic(repo, action, &upstream).await? {
            return Err(invalid(
                "Choose an actual remote branch, not a symbolic remote ref.",
            ));
        }
        if self
            .action_ref_exists(repo, action, &format!("refs/heads/{local}"))
            .await?
        {
            return Err(invalid("The local branch already exists. Choose another name or checkout that branch explicitly; no branch was overwritten."));
        }
        // --create (never --force-create) atomically protects an existing local
        // branch, while --track=direct records this exact remote-tracking ref.
        self.action_write(
            repo,
            action,
            words(&[
                "switch",
                "--create",
                &local,
                "--track=direct",
                "--no-guess",
                "--no-overwrite-ignore",
                "--no-recurse-submodules",
                "--",
                &upstream,
            ]),
        )
        .await
    }

    async fn perform_remote_branch_delete(
        &self,
        repo: &Repository,
        action: &GitAction,
    ) -> Result<String> {
        if action.force != Some(true) {
            return Err(AppError::new(
                "CONFIRMATION_REQUIRED",
                "Deleting a remote branch requires an explicit force=true confirmation.",
            ));
        }
        if action.mode.is_some() || action.set_upstream == Some(true) {
            return Err(invalid(
                "Remote branch deletion does not accept a mode or setUpstream.",
            ));
        }
        let (remote, local) = self
            .action_remote_named(
                repo,
                action,
                required(action.remote.as_deref(), "Remote")?,
                true,
            )
            .await?;
        let branch = remote_branch_name(
            required(
                action.target.as_deref().or(action.branch.as_deref()),
                "Remote branch to delete",
            )?,
            &remote,
        )?;
        let full = format!("refs/heads/{branch}");
        let tracking = format!("refs/remotes/{remote}/{branch}");
        if self.action_ref_is_symbolic(repo, action, &tracking).await? {
            return Err(invalid(
                "Cannot delete a remote HEAD alias; choose a concrete branch.",
            ));
        }
        let lease = self
            .action_remote_ref_lease(repo, action, &full, Some(&tracking))
            .await?;
        self.action_write(
            repo,
            action,
            push_args(&remote, local, &format!(":{full}"), Some(&lease), false),
        )
        .await
    }

    async fn perform_fetch_into(&self, repo: &Repository, action: &GitAction) -> Result<String> {
        ensure_idle(repo)?;
        if action.prune == Some(true) || action.mode.is_some() {
            return Err(invalid(
                "fetch-into updates one local branch and cannot prune refs or accept a mode.",
            ));
        }
        let (remote, local) = self
            .action_fetch_remote(repo, action, required(action.remote.as_deref(), "Remote")?)
            .await?;
        let source = remote_branch_name(
            required(action.target.as_deref(), "Source remote branch")?,
            &remote,
        )?;
        let destination = branch_name(required(
            action.branch.as_deref().or(action.name.as_deref()),
            "Destination local branch",
        )?)?;
        let full = format!("refs/heads/{destination}");
        if self.action_ref_is_symbolic(repo, action, &full).await? {
            return Err(invalid(
                "The destination is a symbolic ref, not a direct local branch.",
            ));
        }
        // Git independently rejects updates to a checked-out branch. Preflight
        // all linked worktrees too, and never use --update-head-ok or reset.
        let worktrees = self
            .action_read(repo, action, words(&["worktree", "list", "--porcelain"]))
            .await?;
        if worktrees
            .lines()
            .any(|line| line.strip_prefix("branch ") == Some(full.as_str()))
        {
            return Err(AppError::new("CHECKED_OUT_BRANCH", "Cannot fetch directly into a branch checked out in this or another worktree. Checkout another branch first; the index and working files were not touched."));
        }
        // Only one direct heads ref may change. Disable implicit tags, pruning,
        // configured fetch mappings and recursion; Git performs the FF check.
        let mut args = network_prefix(local);
        args.extend(["-c".into(), format!("remote.{remote}.tagOpt=--no-tags")]);
        args.extend(words(&[
            "fetch",
            "--atomic",
            "--no-tags",
            "--no-prune",
            "--no-prune-tags",
            "--no-recurse-submodules",
            "--refmap=",
        ]));
        if action.force == Some(true) {
            args.push("--force".into());
        }
        args.extend(["--".into(), remote, format!("refs/heads/{source}:{full}")]);
        self.action_write(repo, action, args).await
    }

    async fn perform_stash(&self, repo: &Repository, action: &GitAction) -> Result<String> {
        let selector = stash_selector(action.target.as_deref().unwrap_or("stash@{0}"))?;
        let oid = self.action_resolve(repo, action, &selector).await?;
        if action.kind == "stash-drop" {
            // Git stash drop/pop need a reflog selector, not the resolved commit.
            // The selector grammar is tiny; recheck its OID under the action lock.
            if self.action_resolve(repo, action, &selector).await? != oid {
                return Err(AppError::new(
                    "STALE_STASH",
                    "The stash list changed. Refresh before retrying.",
                ));
            }
            return self
                .action_write(repo, action, words(&["stash", "drop", "--", &selector]))
                .await;
        }
        ensure_idle(repo)?;
        let reinstate_index = stash_index_requested(action)?;
        self.action_clean_worktree(repo, action).await?;
        if action.kind == "stash-branch" {
            let name = branch_name(required(
                action.name.as_deref().or(action.branch.as_deref()),
                "New stash branch",
            )?)?;
            let parents = self.action_parents(repo, action, &oid).await?;
            let base = parents
                .first()
                .ok_or_else(|| invalid("The selected object is not a stash."))?;
            let mut output = self
                .action_write(
                    repo,
                    action,
                    words(&[
                        "switch",
                        "--create",
                        &name,
                        "--no-guess",
                        "--no-overwrite-ignore",
                        "--no-recurse-submodules",
                        "--",
                        base,
                    ]),
                )
                .await?;
            // Applying by OID, rather than stash branch <selector>, prevents a
            // changed selector from applying/dropping an unrelated entry.
            let mut apply_args = words(&["stash", "apply"]);
            if reinstate_index {
                apply_args.push("--index".into());
            }
            apply_args.extend(["--".into(), oid.clone()]);
            append_output(
                &mut output,
                self.action_write(repo, action, apply_args)
                    .await
                    .map_err(|error| partial_failure(error, format!("Stash branch '{name}' was created, but stash application failed. The stash entry was retained; inspect the branch, index and conflicts before retrying.")))?,
            );
            if self.action_resolve(repo, action, &selector).await? != oid {
                return Err(AppError::new("STALE_STASH", "Stash applied on the new branch, but its selector changed; no stash was dropped. Refresh and inspect the result."));
            }
            append_output(
                &mut output,
                self.action_write(repo, action, words(&["stash", "drop", "--", &selector]))
                    .await?,
            );
            return Ok(output);
        }
        let mut args = words(&["stash", "apply"]);
        if reinstate_index {
            args.push("--index".into());
        }
        args.extend(["--".into(), oid.clone()]);
        let mut output = self.action_write(repo, action, args).await
            .map_err(|error| partial_failure(error, "Stash application failed. The stash entry was retained and Git's index/worktree conflict state was preserved; resolve or inspect it before retrying.".into()))?;
        if action.kind == "stash-pop" {
            if self.action_resolve(repo, action, &selector).await? != oid {
                return Err(AppError::new("STALE_STASH", "Stash applied, but its selector changed; no stash was dropped. Refresh and inspect the result."));
            }
            append_output(
                &mut output,
                self.action_write(repo, action, words(&["stash", "drop", "--", &selector]))
                    .await?,
            );
        }
        Ok(output)
    }

    async fn perform_network(&self, repo: &Repository, action: &GitAction) -> Result<String> {
        if action.kind == "push" {
            if action.mode.is_some() {
                return Err(invalid("Push does not accept a mode."));
            }
            let (remote, local) = self.action_remote(repo, action, true).await?;
            let branch = match action.branch.as_deref().or(action.target.as_deref()) {
                Some(name) => branch_name(name)?,
                None => self.action_head_branch(repo, action).await?,
            };
            let full = format!("refs/heads/{branch}");
            if !self.action_ref_exists(repo, action, &full).await? {
                return Err(invalid("The local branch to push does not exist."));
            }
            if self.action_ref_is_symbolic(repo, action, &full).await? {
                return Err(invalid("Push requires a direct local branch ref."));
            }
            let lease = if action.force == Some(true) {
                let tracking = format!("refs/remotes/{remote}/{branch}");
                Some(
                    self.action_remote_ref_lease(repo, action, &full, Some(&tracking))
                        .await?,
                )
            } else {
                None
            };
            return self
                .action_write(
                    repo,
                    action,
                    push_args(
                        &remote,
                        local,
                        &format!("{full}:{full}"),
                        lease.as_deref(),
                        action.set_upstream == Some(true),
                    ),
                )
                .await;
        }
        if action.kind == "fetch" {
            if action.mode.is_some() || action.set_upstream == Some(true) {
                return Err(invalid("Fetch does not accept mode or setUpstream."));
            }
            // Preflight all URLs/helpers before any remote is contacted. An
            // empty remote means all configured remotes, never an empty URL.
            let names = if action.remote.as_deref() == Some("") {
                self.action_read(repo, action, words(&["remote"]))
                    .await?
                    .lines()
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            } else {
                vec![action.remote.as_deref().unwrap_or("origin").to_owned()]
            };
            if names.is_empty() {
                return Err(invalid("There are no remotes to fetch."));
            }
            let mut remotes = Vec::new();
            for name in names {
                let (remote, local) = self.action_fetch_remote(repo, action, &name).await?;
                let source = action
                    .branch
                    .as_deref()
                    .or(action.target.as_deref())
                    .map(|value| remote_branch_name(value, &remote))
                    .transpose()?;
                remotes.push((remote, local, source));
            }
            let mut output = String::new();
            for (remote, local, source) in remotes {
                let refspec = source
                    .map(|branch| format!("refs/heads/{branch}:refs/remotes/{remote}/{branch}"));
                let fetched = self.action_write(repo, action, fetch_args(action, &remote, local, refspec)).await
                    .map_err(|error| if output.is_empty() { error } else { partial_failure(error, "Fetching all remotes stopped after an error. Previously fetched remotes were retained; no cross-remote rollback was attempted.".into()) })?;
                append_output(&mut output, fetched);
            }
            return Ok(output);
        }
        let (remote, local) = self
            .action_fetch_remote(repo, action, action.remote.as_deref().unwrap_or("origin"))
            .await?;
        if action.kind == "prune" {
            if action.mode.is_some()
                || action.force == Some(true)
                || action.branch.is_some()
                || action.target.is_some()
            {
                return Err(invalid("Prune accepts only a selected remote; no force, mode or branch may be combined."));
            }
            // Explicit refspecs prevent a configured remote.fetch from pruning
            // local branches or tags. This is a fetch+prune of remote heads only.
            let mut prune = action.clone();
            prune.prune = Some(true);
            prune.prune_tags = Some(false);
            return self
                .action_write(repo, action, fetch_args(&prune, &remote, local, None))
                .await;
        }
        ensure_idle(repo)?;
        self.action_clean_worktree(repo, action).await?;
        let current = self.action_head_branch(repo, action).await?;
        let branch = match action.branch.as_deref().or(action.target.as_deref()) {
            Some(name) => remote_branch_name(name, &remote)?,
            None => {
                let tracking = self
                    .action_read(
                        repo,
                        action,
                        words(&[
                            "for-each-ref",
                            "--format=%(upstream:remotename)%00%(upstream:remoteref)",
                            "--",
                            &format!("refs/heads/{current}"),
                        ]),
                    )
                    .await?;
                if let Some((configured_remote, configured_ref)) =
                    tracking.trim_end_matches(['\r', '\n']).split_once('\0')
                {
                    if !configured_remote.is_empty() && configured_remote != remote {
                        return Err(invalid("Selected remote differs from this branch's configured upstream; explicitly choose the remote branch."));
                    }
                    if let Some(name) = configured_ref.strip_prefix("refs/heads/") {
                        branch_name(name)?
                    } else {
                        current.clone()
                    }
                } else {
                    current.clone()
                }
            }
        };
        let mode = action.mode.as_deref().unwrap_or("ff-only");
        if !matches!(mode, "ff-only" | "merge" | "rebase") {
            return Err(invalid("Pull mode must be ff-only, merge or rebase."));
        }
        if mode == "ff-only"
            && (action.no_commit == Some(true)
                || action.no_fast_forward == Some(true)
                || action.squash == Some(true)
                || action.message.is_some())
        {
            return Err(invalid("ff-only pull cannot combine squash/no-commit/no-fast-forward/message; choose merge mode explicitly."));
        }
        if action.set_upstream == Some(true) {
            return Err(invalid(
                "Pull does not set upstream implicitly; use set-upstream explicitly.",
            ));
        }
        // Validate all integration arguments before fetch can mutate any refs.
        if mode != "rebase" {
            merge_args(action, "0000000000000000000000000000000000000000")?;
        }
        let refspec = format!("refs/heads/{branch}:refs/remotes/{remote}/{branch}");
        let mut output = self
            .action_write(
                repo,
                action,
                fetch_args(action, &remote, local, Some(refspec)),
            )
            .await?;
        let oid = self
            .action_resolve(repo, action, &format!("refs/remotes/{remote}/{branch}"))
            .await?;
        let mut integrate = if mode == "rebase" {
            rebase_args(action, &oid, false)
        } else {
            merge_args(action, &oid)?
        };
        if mode == "ff-only" {
            integrate.insert(1, "--ff-only".into());
        }
        let integrated = self.action_write(repo, action, integrate).await
            .map_err(|error| partial_failure(error, "Fetch completed, but pull integration failed or stopped for conflicts. Fetched refs and Git's recovery state were retained; inspect, continue or abort the operation.".into()))?;
        append_output(&mut output, integrated);
        self.action_squash_message(repo, action, &oid).await?;
        Ok(follow_up_note(
            output,
            action.no_commit == Some(true) || action.squash == Some(true),
        ))
    }

    async fn action_preflight_new_url(
        &self,
        repo: &Repository,
        action: &GitAction,
        _name: &str,
        value: &str,
        push: bool,
    ) -> Result<()> {
        remote_location(value, repo.trusted)?;
        // --get-url performs URL expansion only, without contacting the remote
        // or invoking its helper. Unlike remote get-url it accepts a literal URL
        // and does not require a persisted remote config subsection.
        let config = self
            .run_bytes(
                repo,
                &action.request_id,
                words(&["config", "--null", "--list"]),
                false,
            )
            .await
            .map_err(redacted_error)?;
        for record in config.split(|byte| *byte == 0) {
            let Some(boundary) = record.iter().position(|byte| *byte == b'\n') else {
                continue;
            };
            let key = std::str::from_utf8(&record[..boundary])
                .map_err(|_| invalid("A URL rewrite has a non-UTF-8 config key."))?;
            let Some((base, push_only)) = url_rewrite_key(key) else {
                continue;
            };
            if push_only && !push {
                continue;
            }
            let prefix = std::str::from_utf8(&record[boundary + 1..])
                .map_err(|_| invalid("A URL rewrite has a non-UTF-8 prefix."))?;
            if let Some(suffix) = value.strip_prefix(prefix) {
                remote_location(&format!("{base}{suffix}"), repo.trusted)?;
            }
        }
        let expanded = self
            .action_read(
                repo,
                action,
                words(&["ls-remote", "--get-url", "--", value]),
            )
            .await?;
        remote_location(expanded.trim_end_matches(['\r', '\n']), repo.trusted)?;
        if push {
            // pushInsteadOf is selected by the longest matching prefix (Git's
            // documented rule). Validate every equal-longest alternative too,
            // never a just-created fake remote or a user-provided regex.
            let config = self
                .run_bytes(
                    repo,
                    &action.request_id,
                    words(&["config", "--null", "--list"]),
                    false,
                )
                .await
                .map_err(redacted_error)?;
            let mut matches = Vec::new();
            let mut longest = 0;
            for record in config.split(|byte| *byte == 0) {
                let Some(boundary) = record.iter().position(|byte| *byte == b'\n') else {
                    continue;
                };
                let (key, prefix) = (&record[..boundary], &record[boundary + 1..]);
                let key = std::str::from_utf8(key)
                    .map_err(|_| invalid("A URL rewrite has a non-UTF-8 config key."))?;
                let Some(base) = key
                    .strip_prefix("url.")
                    .and_then(|key| key.strip_suffix(".pushinsteadof"))
                else {
                    continue;
                };
                let prefix = std::str::from_utf8(prefix)
                    .map_err(|_| invalid("A URL rewrite has a non-UTF-8 prefix."))?;
                if !value.starts_with(prefix) || prefix.len() < longest {
                    continue;
                }
                if prefix.len() > longest {
                    matches.clear();
                    longest = prefix.len();
                }
                matches.push(format!("{base}{}", &value[prefix.len()..]));
            }
            for rewritten in matches {
                remote_location(&rewritten, repo.trusted)?;
                let expanded = self
                    .action_read(
                        repo,
                        action,
                        words(&["ls-remote", "--get-url", "--", &rewritten]),
                    )
                    .await?;
                remote_location(expanded.trim_end_matches(['\r', '\n']), repo.trusted)?;
            }
        }
        Ok(())
    }

    async fn perform_remote_edit(&self, repo: &Repository, action: &GitAction) -> Result<String> {
        let name = remote_name(required(
            action
                .remote
                .as_deref()
                .or(action.name.as_deref())
                .or(action.target.as_deref()),
            "Remote name",
        )?)?;
        self.action_validate_remote_name(repo, action, &name)
            .await?;
        if action.kind == "remote-remove" {
            return self
                .action_write(repo, action, words(&["remote", "remove", "--", &name]))
                .await;
        }
        let url = required(action.url.as_deref(), "Remote URL")?;
        self.action_preflight_new_url(
            repo,
            action,
            &name,
            url,
            action.mode.as_deref() == Some("push"),
        )
        .await?;
        if action.kind == "remote-add" {
            if !matches!(action.mode.as_deref(), None | Some("fetch")) {
                return Err(invalid("Remote add does not accept a push-only mode."));
            }
            self.action_preflight_new_url(repo, action, &name, url, true)
                .await?;
            return self
                .action_write(repo, action, words(&["remote", "add", "--", &name, url]))
                .await;
        }
        let key = match action.mode.as_deref().unwrap_or("fetch") {
            "fetch" => format!("remote.{name}.url"),
            "push" => format!("remote.{name}.pushurl"),
            _ => return Err(invalid("Remote edit mode must be fetch or push.")),
        };
        let remotes = self.action_read(repo, action, words(&["remote"])).await?;
        if !remotes.lines().any(|v| v == name) {
            return Err(invalid("The remote to edit does not exist."));
        }
        // Replace all entries in the selected scope; do not silently leave an old
        // second push URL active. No user-supplied regex is passed to set-url.
        self.action_write(
            repo,
            action,
            words(&["config", "--local", "--replace-all", "--", &key, url]),
        )
        .await
    }

    async fn perform_recovery(&self, repo: &Repository, action: &GitAction) -> Result<String> {
        ensure_worktree(repo)?;
        let operation = operation_on_disk(repo)?.ok_or_else(|| {
            AppError::new(
                "NO_OPERATION",
                "No merge, rebase, cherry-pick or revert is in progress.",
            )
        })?;
        let command = operation.name();
        let mut args = words(&[
            command,
            if action.kind == "continue" {
                "--continue"
            } else {
                "--abort"
            },
        ]);
        if action.kind == "continue" {
            match (operation, action.sign) {
                (Operation::Merge, Some(sign)) => {
                    args.splice(
                        0..0,
                        words(&[
                            "-c",
                            if sign {
                                "commit.gpgSign=true"
                            } else {
                                "commit.gpgSign=false"
                            },
                        ]),
                    );
                }
                _ => signed(&mut args, action),
            }
        } else if action.sign == Some(true) {
            return Err(invalid(
                "Abort does not create a commit and cannot request signing.",
            ));
        }
        // Git owns the recovery protocol. On conflicts or any error, preserve
        // its state for the caller; never auto-abort or delete an index.lock.
        self.action_write(repo, action, args).await
    }

    async fn perform_follow_up_commit(
        &self,
        repo: &Repository,
        action: &GitAction,
    ) -> Result<String> {
        ensure_worktree(repo)?;
        let operation = operation_on_disk(repo)?;
        if operation == Some(Operation::Rebase) {
            return Err(AppError::new(
                "USE_CONTINUE",
                "Use continue to finish a rebase, not a standalone commit.",
            ));
        }
        let squash = marker(&Path::new(&repo.git_dir).join("SQUASH_MSG"))?;
        if operation.is_none()
            && !squash
            && !(action.force == Some(true) && action.mode.as_deref() == Some("follow-up"))
        {
            return Err(AppError::new("FOLLOW_UP_CONFIRMATION_REQUIRED", "Commit is limited to operation follow-up. To commit an existing index without an operation marker, explicitly confirm force=true and mode=follow-up. No files will be staged."));
        }
        let conflicts = self
            .run_bytes(
                repo,
                &action.request_id,
                words(&["ls-files", "--unmerged", "-z"]),
                false,
            )
            .await?;
        if !conflicts.is_empty() {
            return Err(AppError::new(
                "UNRESOLVED_CONFLICTS",
                "Resolve conflicts and stage the resolutions before committing.",
            ));
        }
        let mut args = words(&["commit", "--no-edit"]);
        if let Some(message) = &action.message {
            if message.trim().is_empty() {
                return Err(invalid("Commit message must not be empty."));
            }
            args.extend(["--message".into(), message.clone()]);
        } else if operation.is_none() && !squash {
            return Err(invalid(
                "A follow-up commit without Git's operation message requires an explicit message.",
            ));
        }
        signed(&mut args, action);
        self.action_write(repo, action, args).await
    }
}

fn tag_create_args(
    action: &GitAction,
    name: &str,
    oid: &str,
    git_signs_tags: bool,
) -> Result<Vec<String>> {
    let annotated = match action.tag_type.as_deref() {
        Some("annotated") => true,
        Some("lightweight") => false,
        None => {
            action.message.is_some()
                || action.sign == Some(true)
                || action.sign.is_none() && git_signs_tags
        }
        _ => return Err(invalid("Tag type must be lightweight or annotated.")),
    };
    if !annotated && (action.message.is_some() || action.sign == Some(true)) {
        return Err(invalid("A lightweight tag cannot have an annotation or a signature; select annotated explicitly."));
    }
    if !annotated && action.sign.is_none() && git_signs_tags {
        return Err(invalid("Git's tag.gpgSign configuration requests a signed annotated tag. Select annotated, or explicitly choose sign=false to create a lightweight tag."));
    }
    if annotated {
        let message = required(action.message.as_deref(), "Annotated tag message")?;
        if message.trim().is_empty() {
            return Err(invalid("An annotated tag needs a nonempty message; no editor is launched in a background action."));
        }
    }
    let mut args = words(&["tag"]);
    if action.force == Some(true) {
        args.push("--force".into());
    }
    if annotated {
        args.push("--annotate".into());
    }
    match action.sign {
        Some(true) => args.push("--sign".into()),
        Some(false) => args.push("--no-sign".into()),
        None => {}
    }
    if let Some(message) = &action.message {
        args.extend(["--message".into(), message.clone()]);
    }
    args.extend(["--".into(), name.to_owned(), oid.to_owned()]);
    Ok(args)
}

fn switch_branch_args(name: &str) -> Vec<String> {
    words(&[
        "switch",
        "--no-guess",
        "--no-recurse-submodules",
        "--no-overwrite-ignore",
        "--",
        name,
    ])
}

fn partial_failure(mut error: AppError, context: String) -> AppError {
    let previous = error.message;
    error.message = context;
    error.detail = Some(match error.detail {
        Some(detail) => format!("{previous}\n{detail}"),
        None => previous,
    });
    error
}

fn remote_branch_name(value: &str, remote: &str) -> Result<String> {
    if let Some(full) = value.strip_prefix("refs/remotes/") {
        let branch = full
            .strip_prefix(&format!("{remote}/"))
            .ok_or_else(|| invalid("The remote-tracking ref belongs to a different remote."))?;
        if branch == "HEAD" {
            return Err(invalid(
                "Choose an actual remote branch, not a remote HEAD alias.",
            ));
        }
        branch_name(branch)
    } else {
        branch_name(value)
    }
}

fn stash_index_requested(action: &GitAction) -> Result<bool> {
    match action.mode.as_deref() {
        None => Ok(action.reinstate_index == Some(true)),
        Some("index") if action.reinstate_index != Some(false) => Ok(true),
        Some("index") => Err(invalid(
            "reinstateIndex=false conflicts with legacy mode=index.",
        )),
        Some(_) => Err(invalid(
            "Stash apply/pop/branch mode must be index or omitted.",
        )),
    }
}

fn fetch_args(
    action: &GitAction,
    remote: &str,
    local: bool,
    refspec: Option<String>,
) -> Vec<String> {
    let mut args = network_prefix(local);
    args.extend(["-c".into(), format!("remote.{remote}.tagOpt=")]);
    args.extend(words(&[
        "fetch",
        "--atomic",
        "--no-recurse-submodules",
        "--refmap=",
    ]));
    args.push(
        if action.prune == Some(true) {
            "--prune"
        } else {
            "--no-prune"
        }
        .into(),
    );
    args.push(
        if action.prune_tags == Some(true) {
            "--prune-tags"
        } else {
            "--no-prune-tags"
        }
        .into(),
    );
    if action.force == Some(true) {
        args.push("--force".into());
    }
    args.extend(["--".into(), remote.to_owned()]);
    args.push(refspec.unwrap_or_else(|| format!("refs/heads/*:refs/remotes/{remote}/*")));
    if action.prune_tags == Some(true) {
        // --refmap= deliberately disables configured mappings. Supply the tag
        // namespace explicitly as well: --prune-tags alone is not sufficient
        // with an explicit heads-only command-line refspec on all Git versions.
        args.push("refs/tags/*:refs/tags/*".into());
    }
    args
}

pub(super) fn push_args(
    remote: &str,
    local: bool,
    refspec: &str,
    lease: Option<&str>,
    set_upstream: bool,
) -> Vec<String> {
    let mut args = network_prefix(local);
    args.extend(["-c".into(), format!("remote.{remote}.mirror=false")]);
    args.extend(words(&[
        "push",
        "--porcelain",
        "--no-follow-tags",
        "--recurse-submodules=no",
    ]));
    if let Some(lease) = lease {
        args.push(lease.to_owned());
    }
    if set_upstream {
        args.push("--set-upstream".into());
    }
    args.extend(["--".into(), remote.to_owned(), refspec.to_owned()]);
    args
}

fn append_output(output: &mut String, next: String) {
    if !output.is_empty() && !next.is_empty() {
        output.push('\n');
    }
    output.push_str(&next);
}

fn follow_up_note(mut output: String, required: bool) -> String {
    if required {
        append_output(&mut output, "Changes were left for review without a commit. Use the operation's continue action when available, or explicitly confirmed follow-up commit (force=true, mode=follow-up) to commit only the current index; staging/resolution can be completed in an external tool.".into());
    }
    output
}

#[cfg(test)]
mod parity_argv_tests {
    use super::*;

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";

    fn request(kind: &str, extra: serde_json::Value) -> GitAction {
        let mut value =
            serde_json::json!({"repoId": "r", "requestId": "argv-parity", "kind": kind});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn rebase_argv_applies_date_merge_and_three_state_signing() {
        let action = request(
            "rebase",
            serde_json::json!({"ignoreDate":true,"preserveMerges":true}),
        );
        let args = rebase_args(&action, OID, true);
        assert!(args.iter().any(|arg| arg == "--rebase-merges"));
        assert!(args.iter().any(|arg| arg == "--ignore-date"));
        assert!(args.iter().any(|arg| arg == "--interactive"));
        assert!(!args
            .iter()
            .any(|arg| arg == "--no-rebase-merges" || arg == "--no-gpg-sign"));
        let action = request("rebase", serde_json::json!({"sign":false}));
        assert!(rebase_args(&action, OID, false)
            .iter()
            .any(|arg| arg == "--no-gpg-sign"));
        let action = request("rebase", serde_json::json!({"sign":true}));
        assert!(rebase_args(&action, OID, false)
            .iter()
            .any(|arg| arg == "--gpg-sign"));
    }

    #[test]
    fn tag_type_does_not_silently_override_git_sign_configuration() {
        let action = request(
            "tag-create",
            serde_json::json!({"tagType":"annotated","message":"说明"}),
        );
        let args = tag_create_args(&action, "v1", OID, true).unwrap();
        assert_eq!(args[0], "tag");
        assert!(args.iter().any(|arg| arg == "--annotate"));
        assert!(!args
            .iter()
            .any(|arg| arg == "--no-sign" || arg == "tag.gpgSign=false"));
        let light = request("tag-create", serde_json::json!({"tagType":"lightweight"}));
        assert!(tag_create_args(&light, "v1", OID, true).is_err());
        let light = request(
            "tag-create",
            serde_json::json!({"tagType":"lightweight","sign":false}),
        );
        let args = tag_create_args(&light, "v1", OID, true).unwrap();
        assert!(args.iter().any(|arg| arg == "--no-sign"));
        assert!(!args.iter().any(|arg| arg == "--annotate"));
        let invalid = request(
            "tag-create",
            serde_json::json!({"tagType":"lightweight","message":"ignored?"}),
        );
        assert!(tag_create_args(&invalid, "v1", OID, false).is_err());
    }

    #[test]
    fn fetch_argv_controls_prune_tags_and_ignores_configured_refmaps() {
        let action = request("fetch", serde_json::json!({}));
        let args = fetch_args(&action, "团队/远端.一", true, None);
        assert!(args.iter().any(|arg| arg == "--no-prune"));
        assert!(args.iter().any(|arg| arg == "--no-prune-tags"));
        assert!(args.iter().any(|arg| arg == "--refmap="));
        assert_eq!(
            args.last().unwrap(),
            "refs/heads/*:refs/remotes/团队/远端.一/*"
        );
        assert!(!args.iter().any(|arg| arg == "--force"));
        let action = request(
            "fetch",
            serde_json::json!({"prune":true,"pruneTags":true,"force":true}),
        );
        let args = fetch_args(&action, "origin", false, None);
        for flag in ["--prune", "--prune-tags", "--force"] {
            assert!(args.iter().any(|arg| arg == flag));
        }
        assert!(
            validate_action_options(&request("fetch", serde_json::json!({"pruneTags":true})))
                .is_err()
        );
    }

    #[test]
    fn pick_argv_requires_actual_mainline_and_records_origin_only_explicitly() {
        let action = request(
            "cherry-pick",
            serde_json::json!({"recordOrigin":true,"mode":"mainline:2"}),
        );
        let args = pick_args(&action, OID, 2).unwrap();
        assert!(args.windows(2).any(|pair| pair == ["--mainline", "2"]));
        assert!(args.iter().any(|arg| arg == "-x"));
        assert_eq!(&args[args.len() - 2..], &["--".to_owned(), OID.to_owned()]);
        for mode in [
            "mainline:3",
            "mainline:0",
            "mainline:-1",
            "mainline:01",
            "mainline:+1",
        ] {
            assert!(pick_args(
                &request("cherry-pick", serde_json::json!({"mode":mode})),
                OID,
                2
            )
            .is_err());
        }
        assert!(pick_args(&action, OID, 1).is_err());
    }

    #[test]
    fn new_options_fail_closed_for_unsupported_combinations() {
        for (kind, options) in [
            ("checkout", serde_json::json!({"checkoutAfter":false})),
            ("push", serde_json::json!({"tagType":"annotated"})),
            ("reset", serde_json::json!({"reinstateIndex":true})),
            ("revert", serde_json::json!({"recordOrigin":false})),
            ("merge", serde_json::json!({"ignoreDate":true})),
            ("fetch-into", serde_json::json!({"pruneTags":false})),
            (
                "pull",
                serde_json::json!({"mode":"merge","preserveMerges":false}),
            ),
            ("merge", serde_json::json!({"squashMessage":"summary"})),
            ("drop", serde_json::json!({"preserveMerges":true})),
        ] {
            assert!(
                validate_action_options(&request(kind, options)).is_err(),
                "{kind}"
            );
        }
        assert!(stash_index_requested(&request(
            "stash-pop",
            serde_json::json!({"reinstateIndex":false,"mode":"index"})
        ))
        .is_err());
        assert!(!stash_index_requested(&request(
            "stash-branch",
            serde_json::json!({"reinstateIndex":false})
        ))
        .unwrap());
        assert!(stash_index_requested(&request(
            "stash-apply",
            serde_json::json!({"mode":"index"})
        ))
        .unwrap());
    }

    #[test]
    fn credential_urls_are_rejected_and_error_text_is_redacted() {
        for value in [
            "https://token@example.invalid/repo.git",
            "https://user:secret@example.invalid/repo.git",
            "ssh://git:secret@example.invalid/repo.git",
            "git://token@example.invalid/repo.git",
            "https://example.invalid/repo.git?access_token=secret",
        ] {
            assert!(remote_location(value, true).is_err(), "{value}");
        }
        let text = redact_network_text(
            "fatal: 'HTTPS://user:secret@example.invalid/repo?token=hidden' failed\n",
        );
        assert!(!text.contains("secret") && !text.contains("hidden"));
        assert!(text.contains("[redacted]"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";
    const PARENT: &str = "abcdef0123456789abcdef0123456789abcdef01";

    fn action(kind: &str) -> GitAction {
        serde_json::from_value(serde_json::json!({
            "repoId": "test-repository", "requestId": "unit-action", "kind": kind
        }))
        .unwrap()
    }

    fn repository(git_dir: &Path) -> Repository {
        Repository {
            id: "test-repository".into(),
            path: git_dir.to_string_lossy().into_owned(),
            name: "Unit test".into(),
            git_dir: git_dir.to_string_lossy().into_owned(),
            common_dir: git_dir.to_string_lossy().into_owned(),
            head: None,
            branch: None,
            trusted: true,
            bare: false,
        }
    }

    #[test]
    fn references_reject_options_revision_syntax_and_controls() {
        for value in [
            "",
            "-main",
            "--upload-pack=evil",
            "../main",
            "main..other",
            "main^{commit}",
            "HEAD~1",
            "a:b",
            "refs//main",
            ".hidden",
            "a/.hidden",
            "foo.lock",
            "foo.LOCK",
            "a b",
            "a\\b",
            "a\nb",
            "a\tb",
            "a\0b",
            "a\u{0085}b",
            "foo@{1}",
            "name.",
            "name/",
            "@",
        ] {
            assert!(ref_name(value).is_err(), "accepted {value:?}");
        }
        for value in [
            "main",
            "feature/windows-first",
            "版本/修复",
            "release-2026.11",
            "refs/heads/main",
        ] {
            assert!(ref_name(value).is_ok(), "rejected {value:?}");
        }
    }

    #[test]
    fn branch_and_tag_names_keep_namespaces_separate() {
        assert_eq!(branch_name("refs/heads/topic").unwrap(), "topic");
        assert_eq!(tag_name("refs/tags/v1").unwrap(), "v1");
        for value in ["HEAD", "refs/tags/v1", "refs/remotes/origin/main"] {
            assert!(branch_name(value).is_err());
        }
        for value in ["HEAD", "refs/heads/main", "refs/remotes/origin/main"] {
            assert!(tag_name(value).is_err());
        }
    }

    #[test]
    fn revisions_have_no_free_form_expression_escape() {
        assert_eq!(revision("HEAD").unwrap(), Revision::Head);
        assert_eq!(revision(OID).unwrap(), Revision::Hash(OID.into()));
        assert_eq!(revision("ABCDEF").unwrap(), Revision::Hash("abcdef".into()));
        assert_eq!(
            revision("refs/heads/main").unwrap(),
            Revision::Ref("refs/heads/main".into())
        );
        assert_eq!(
            revision("stash@{12}").unwrap(),
            Revision::Stash("stash@{12}".into())
        );
        for value in [
            "HEAD^",
            "HEAD~2",
            "main...topic",
            ":/message",
            "@{-1}",
            "HEAD:path",
            "refs/x",
            "--all",
        ] {
            assert!(revision(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn stash_selectors_are_only_canonical_unsigned_indices() {
        for value in ["stash@{0}", "stash@{1}", "stash@{4294967295}"] {
            assert_eq!(stash_selector(value).unwrap(), value);
        }
        for value in [
            "stash",
            "refs/stash",
            "stash@{-1}",
            "stash@{+1}",
            "stash@{01}",
            "stash@{1 day ago}",
            "stash@{4294967296}",
            "stash@{0}^",
            "stash@{}",
            "--index",
        ] {
            assert!(stash_selector(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn remote_names_cannot_escape_config_subsection_or_be_urls() {
        for value in [
            "origin",
            "work-remote",
            "test_2",
            "123",
            "a.b",
            "a/b",
            "团队/远端.一",
        ] {
            assert!(remote_name(value).is_ok());
        }
        for value in [
            "",
            "-origin",
            "a..b",
            "a//b",
            "a/../b",
            "a:b",
            "a\"b",
            "a'b",
            "HEAD",
            "a\nb",
            "origin pushurl",
            "a\\b",
            "a@{0}",
        ] {
            assert!(remote_name(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn remote_urls_allow_known_transports_and_safe_ssh() {
        for value in [
            "https://example.invalid/repo.git",
            "http://localhost/repo.git",
            "ssh://git@example.invalid:2222/repo.git",
            "git://example.invalid/repo.git",
            "git@example.invalid:team/repo.git",
            "ssh://git@[::1]/repo.git",
        ] {
            assert!(!remote_location(value, true).unwrap().local, "{value}");
        }
    }

    #[test]
    fn remote_urls_forbid_helpers_option_hosts_and_encoded_controls() {
        for value in [
            "ext::sh -c evil",
            "hg::https://example.invalid/repo",
            "foo://example.invalid/repo",
            "--upload-pack=evil",
            "https://example.invalid/repo\nnext",
            "https://-option/repo",
            "https://example.invalid/a%0ab",
            "ssh://-evil@example.invalid/repo",
            "user@-evil:path",
            "https://example.invalid/repo?helper=ext",
            "https://example.invalid/repo#fragment",
            "\\\\server\\repo",
            "//server/repo",
            "file://server/share/repo",
            "origin",
        ] {
            assert!(remote_location(value, true).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn local_paths_and_file_urls_require_trust() {
        for value in [
            "C:\\test repos\\remote.git",
            "C:/test/remote.git",
            "./remote.git",
            "../remote.git",
            "/tmp/local.git",
            "file:///C:/test/remote.git",
        ] {
            assert!(remote_location(value, true).unwrap().local, "{value}");
            assert!(remote_location(value, false).is_err(), "{value}");
        }
        assert!(remote_location("C:/test/repo:stream", true).is_err());
    }

    #[test]
    fn parsed_oid_is_exactly_one_full_hash() {
        assert_eq!(parse_oid(&format!("{OID}\n")).unwrap(), OID);
        assert!(parse_oid(&"a".repeat(64)).is_ok());
        for value in [
            "HEAD",
            "1234",
            "",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        ] {
            assert!(parse_oid(value).is_err());
        }
        assert!(parse_oid(&format!("{OID}\n{PARENT}")).is_err());
    }

    #[test]
    fn no_commit_merge_cannot_fast_forward_without_stopping() {
        let mut request = action("merge");
        request.no_commit = Some(true);
        request.sign = Some(true);
        request.message = Some("--not-a-flag\nSecond line".into());
        let args = merge_args(&request, OID).unwrap();
        assert!(args.iter().any(|s| s == "--no-ff"));
        assert!(args.iter().any(|s| s == "--no-commit"));
        assert!(args.iter().any(|s| s == "--gpg-sign"));
        assert_eq!(&args[args.len() - 2..], &["--".to_owned(), OID.to_owned()]);
        let message_index = args.iter().position(|s| s == "--message").unwrap();
        assert_eq!(args[message_index + 1], "--not-a-flag\nSecond line");
    }

    #[test]
    fn squash_and_noff_are_not_silently_combined() {
        let mut request = action("merge");
        request.squash = Some(true);
        let args = merge_args(&request, OID).unwrap();
        assert!(args.iter().any(|s| s == "--squash"));
        assert!(args.iter().any(|s| s == "--no-commit"));
        assert!(!args.iter().any(|s| s == "--commit"));
        request.no_fast_forward = Some(true);
        assert!(merge_args(&request, OID).is_err());
    }

    #[test]
    fn rebase_and_drop_argv_use_generated_oids_not_branch_positionals() {
        let request = action("rebase");
        let args = rebase_args(&request, OID, false);
        assert!(!args
            .iter()
            .any(|s| s == "--interactive" || s == "--no-interactive"));
        assert!(args.iter().any(|s| s == "--no-autostash"));
        assert!(args.iter().any(|s| s == "--no-update-refs"));
        assert_eq!(args.last().unwrap(), OID);
        assert!(rebase_args(&request, OID, true)
            .iter()
            .any(|s| s == "--interactive"));
        let args = drop_args(&request, PARENT, OID);
        let onto = args.iter().position(|s| s == "--onto").unwrap();
        assert_eq!(args[onto + 1], PARENT);
        assert_eq!(args.last().unwrap(), OID);
        assert_eq!(args.iter().filter(|s| *s == OID).count(), 1);
    }

    #[test]
    fn reset_modes_are_whitelisted_and_hard_requires_confirmation() {
        let mut request = action("reset");
        for (mode, flag) in [("soft", "--soft"), ("mixed", "--mixed"), ("keep", "--keep")] {
            request.mode = Some(mode.into());
            assert_eq!(
                reset_args(&request, OID).unwrap(),
                words(&["reset", flag, OID, "--"])
            );
        }
        request.mode = Some("hard".into());
        assert!(reset_args(&request, OID).is_err());
        request.force = Some(true);
        assert!(reset_args(&request, OID)
            .unwrap()
            .iter()
            .any(|s| s == "--hard"));
        request.mode = Some("--merge --hard".into());
        assert!(reset_args(&request, OID).is_err());
    }

    #[test]
    fn clean_only_dry_runs_and_never_passes_force_to_git() {
        let mut request = action("clean");
        assert!(clean_args(&request).is_err());
        request.mode = Some("preview".into());
        assert_eq!(
            clean_args(&request).unwrap(),
            words(&["clean", "--dry-run", "-d", "--"])
        );
        request.include_ignored = Some(true);
        assert!(clean_args(&request).unwrap().iter().any(|s| s == "-x"));
        request.include_untracked = Some(false);
        assert!(clean_args(&request).unwrap().iter().any(|s| s == "-X"));
        request.force = Some(true);
        request.mode = Some("delete".into());
        let args = clean_args(&request).unwrap();
        assert!(args.iter().any(|s| s == "--dry-run"));
        assert!(!args
            .iter()
            .any(|s| matches!(s.as_str(), "--force" | "-f" | "-ff")));
    }

    #[test]
    fn identity_scope_is_fixed_and_global_needs_specific_confirmation() {
        let mut request = action("identity");
        request.name = Some("Test Identity".into());
        request.email = Some("test@example.invalid".into());
        let commands = identity_args(&request).unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(
            commands[0],
            words(&[
                "config",
                "--local",
                "--replace-all",
                "--",
                "user.name",
                "Test Identity"
            ])
        );
        assert_eq!(commands[1][4], "user.email");
        request.global = Some(true);
        assert!(identity_args(&request).is_err());
        request.mode = Some("confirmed-global".into());
        assert_eq!(identity_args(&request).unwrap()[0][1], "--global");
        request.name = Some("attacker\n[alias]\npwn = !evil".into());
        assert!(identity_args(&request).is_err());
    }

    #[test]
    fn network_protocol_policy_denies_external_helpers() {
        let args = network_prefix(false);
        assert!(args.iter().any(|s| s == "protocol.allow=never"));
        assert!(args.iter().any(|s| s == "protocol.ext.allow=never"));
        assert!(args.iter().any(|s| s == "protocol.file.allow=never"));
        assert!(network_prefix(true)
            .iter()
            .any(|s| s == "protocol.file.allow=always"));
    }

    #[test]
    fn operation_is_detected_from_worktree_specific_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        assert_eq!(operation_on_disk(&repo).unwrap(), None);
        fs::write(dir.path().join("SQUASH_MSG"), "a squash message").unwrap();
        assert_eq!(operation_on_disk(&repo).unwrap(), None);
        fs::write(dir.path().join("MERGE_HEAD"), OID).unwrap();
        assert_eq!(operation_on_disk(&repo).unwrap(), Some(Operation::Merge));
        fs::create_dir(dir.path().join("rebase-merge")).unwrap();
        assert_eq!(operation_on_disk(&repo).unwrap(), Some(Operation::Rebase));
        fs::remove_dir(dir.path().join("rebase-merge")).unwrap();
        fs::remove_file(dir.path().join("MERGE_HEAD")).unwrap();
        fs::write(dir.path().join("REVERT_HEAD"), OID).unwrap();
        assert_eq!(operation_on_disk(&repo).unwrap(), Some(Operation::Revert));
        fs::remove_file(dir.path().join("REVERT_HEAD")).unwrap();
        fs::create_dir(dir.path().join("sequencer")).unwrap();
        fs::write(
            dir.path().join("sequencer/todo"),
            format!("# a comment\npick {OID} subject\n"),
        )
        .unwrap();
        assert_eq!(
            operation_on_disk(&repo).unwrap(),
            Some(Operation::CherryPick)
        );
    }

    #[test]
    fn action_envelope_checks_trust_repository_and_control_characters() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = repository(dir.path());
        let mut request = action("merge");
        assert!(check_envelope(&repo, &request).is_ok());
        repo.trusted = false;
        assert!(check_envelope(&repo, &request).is_err());
        repo.trusted = true;
        request.repo_id = "other-repository".into();
        assert!(check_envelope(&repo, &request).is_err());
        request.repo_id = repo.id.clone();
        request.url = Some("https://example.invalid/repo\rmore".into());
        assert!(check_envelope(&repo, &request).is_err());
        request.url = None;
        request.message = Some("A multiline commit\n\nBody".into());
        assert!(check_envelope(&repo, &request).is_ok());
    }
}
