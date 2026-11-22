//! Repository, tag, stash, containment and submodule inspection. None of these
//! queries invokes a verifier, a submodule update command or a network operation.

use std::{collections::BTreeMap, fs, path::PathBuf};

use super::{
    argument,
    history::{oid_input, REF_LIMIT},
    io_error, parse_oid_line, validate_path, validate_revision, CONTENT_LIMIT, REF_FORMAT,
};
use crate::{
    error::{AppError, Result},
    git::{parse, GitService},
    model::*,
};

const STASH_CONTAINMENT_LIMIT: usize = 256;
const SUBMODULE_LIMIT: usize = 256;

fn invalid(message: &str) -> AppError {
    AppError::new("GIT_PARSE", message)
}

impl GitService {
    pub async fn snapshot(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<RepositorySnapshot> {
        let _scope = self.request_scope(request_id)?;
        let (references, working, remotes) = tokio::join!(
            self.reference_state(repo, request_id),
            self.working_state(repo, request_id),
            self.remotes(repo, request_id),
        );
        let (refs, stashes) = references?;
        let working = working?;
        let remotes = remotes?;
        let mut repository = repo.clone();
        repository.head = working.head.clone();
        repository.branch = working.branch.clone();
        // Stable non-cryptographic change token, not a security/authentication hash.
        // Sorting avoids making the token depend on Git's ref/status display order.
        let mut sorted_refs = refs.clone();
        sorted_refs.sort_by(|a, b| a.full_name.cmp(&b.full_name).then(a.oid.cmp(&b.oid)));
        let mut sorted_working = working.clone();
        sorted_working
            .files
            .sort_by(|a, b| a.path.cmp(&b.path).then(a.old_path.cmp(&b.old_path)));
        let bytes = serde_json::to_vec(&(
            &repository.head,
            &repository.branch,
            &sorted_refs,
            &sorted_working,
            &stashes,
            &remotes,
        ))
        .map_err(|error| AppError::new("SERIALIZE", error.to_string()))?;
        let mut hash = 0xcbf29ce484222325u64;
        for byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        Ok(RepositorySnapshot {
            repository,
            refs,
            working,
            stashes,
            remotes,
            fingerprint: format!("v1-{hash:016x}"),
        })
    }

    pub async fn tag_detail(
        &self,
        repo: &Repository,
        target: &str,
        request_id: &str,
    ) -> Result<TagDetail> {
        let full_ref = if target.starts_with("refs/") {
            target.to_owned()
        } else {
            format!("refs/tags/{target}")
        };
        validate_revision(&full_ref)?;
        let name = full_ref
            .strip_prefix("refs/tags/")
            .ok_or_else(|| argument("Tag detail requires a tag name or full refs/tags/... ref"))?
            .to_owned();
        let output = self
            .run(
                repo,
                request_id,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--end-of-options".into(),
                    full_ref.clone(),
                ],
                false,
            )
            .await?;
        let oid = parse_oid_line(&output)?;
        let kind = self.object_kind(repo, request_id, &oid).await?;
        let annotated = kind == "tag";
        let (tagger, email, timestamp, message, signed) = if annotated {
            self.check_small_object(repo, request_id, &oid).await?;
            let bytes = self
                .run_bytes(
                    repo,
                    request_id,
                    vec!["cat-file".into(), "tag".into(), oid.clone()],
                    false,
                )
                .await?;
            let tag = parse::tag_object(&bytes)?;
            (
                tag.tagger,
                tag.email,
                tag.timestamp,
                tag.message,
                tag.signed,
            )
        } else {
            (String::new(), String::new(), None, String::new(), false)
        };
        let target_oid = if annotated {
            parse_oid_line(
                &self
                    .run(
                        repo,
                        request_id,
                        vec![
                            "rev-parse".into(),
                            "--verify".into(),
                            "--end-of-options".into(),
                            format!("{full_ref}^{{}}"),
                        ],
                        false,
                    )
                    .await?,
            )?
        } else {
            oid.clone()
        };
        let target_type = self.object_kind(repo, request_id, &target_oid).await?;
        Ok(TagDetail {
            name,
            r#ref: full_ref,
            oid,
            target_oid,
            target_type,
            annotated,
            tagger,
            email,
            timestamp,
            message,
            signature: Signature {
                status: if signed { "U" } else { "N" }.into(),
                signer: String::new(),
                key: String::new(),
            },
        })
    }

    async fn object_kind(&self, repo: &Repository, request_id: &str, oid: &str) -> Result<String> {
        oid_input(&[oid.to_owned()])?;
        let output = self
            .run(
                repo,
                request_id,
                vec!["cat-file".into(), "-t".into(), oid.into()],
                false,
            )
            .await?;
        let kind = output.trim();
        if !matches!(kind, "commit" | "tree" | "blob" | "tag") {
            return Err(invalid("Unknown Git object type"));
        }
        Ok(kind.into())
    }

    async fn check_small_object(
        &self,
        repo: &Repository,
        request_id: &str,
        oid: &str,
    ) -> Result<()> {
        oid_input(&[oid.to_owned()])?;
        let output = self
            .run(
                repo,
                request_id,
                vec!["cat-file".into(), "-s".into(), oid.into()],
                false,
            )
            .await?;
        let size: usize = output
            .trim()
            .parse()
            .map_err(|_| invalid("Invalid Git object size"))?;
        if size > CONTENT_LIMIT {
            return Err(AppError::new(
                "OUTPUT_LIMIT",
                "Detail/config object exceeds 2 MiB",
            ));
        }
        Ok(())
    }

    pub async fn stash_detail(
        &self,
        repo: &Repository,
        selector: &str,
        request_id: &str,
    ) -> Result<StashDetail> {
        validate_revision(selector)?;
        if !selector.starts_with("stash@{") {
            return Err(argument(
                "Stash detail requires a numbered stash@{N} selector",
            ));
        }
        let stash = self
            .stashes(repo, request_id)
            .await?
            .into_iter()
            .find(|stash| stash.selector == selector)
            .ok_or_else(|| argument("This stash selector does not exist"))?;
        self.check_small_object(repo, request_id, &stash.oid)
            .await?;
        let raw = self
            .run_bytes(
                repo,
                request_id,
                vec!["cat-file".into(), "commit".into(), stash.oid.clone()],
                false,
            )
            .await?;
        let commit = parse::stash_commit(&raw)?;
        if !matches!(commit.parents.len(), 2 | 3) {
            return Err(invalid(
                "Stash commit must have base/index and optionally untracked parents",
            ));
        }
        Ok(StashDetail {
            selector: stash.selector,
            oid: stash.oid,
            base: commit.parents[0].clone(),
            index: commit.parents[1].clone(),
            untracked: commit.parents.get(2).cloned(),
            message: commit.message,
            timestamp: commit.timestamp,
        })
    }

    pub async fn containment(
        &self,
        repo: &Repository,
        revision: &str,
        request_id: &str,
    ) -> Result<Containment> {
        let oid = self.resolve_revision(repo, request_id, revision).await?;
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                vec![
                    "for-each-ref".into(),
                    format!("--contains={oid}"),
                    format!("--format={REF_FORMAT}"),
                    format!("--count={}", REF_LIMIT + 1),
                    "refs/heads/".into(),
                    "refs/remotes/".into(),
                    "refs/tags/".into(),
                ],
                false,
            )
            .await?;
        let mut refs = parse::refs(&bytes)?;
        if refs.len() > REF_LIMIT {
            return Err(AppError::new(
                "CONTAINMENT_LIMIT",
                "Containment exceeds 20000 refs",
            ));
        }
        for item in &refs {
            validate_revision(&item.full_name)?;
        }
        let head = match self.optional_head(repo, request_id).await? {
            Some(head) => self.oid_is_ancestor(repo, request_id, &oid, &head).await?,
            None => false,
        };
        let stashes = self.stashes(repo, request_id).await?;
        if stashes.len() > STASH_CONTAINMENT_LIMIT {
            return Err(AppError::new(
                "CONTAINMENT_LIMIT",
                "Containment supports at most 256 stash entries; no partial result was returned",
            ));
        }
        for stash in stashes {
            if self
                .oid_is_ancestor(repo, request_id, &oid, &stash.oid)
                .await?
            {
                refs.push(GitRef {
                    name: stash.selector.clone(),
                    full_name: stash.selector,
                    oid: stash.oid,
                    kind: "stash".into(),
                    upstream: None,
                    current: false,
                    subject: stash.message,
                });
            }
        }
        refs.sort_by(|a, b| a.full_name.cmp(&b.full_name));
        Ok(Containment { oid, head, refs })
    }

    pub async fn submodules(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<Vec<SubmoduleInfo>> {
        let (gitlinks, modules_oid) = if repo.bare {
            let Some(head) = self.optional_head(repo, request_id).await? else {
                return Ok(Vec::new());
            };
            let bytes = self
                .run_bytes(
                    repo,
                    request_id,
                    vec![
                        "ls-tree".into(),
                        "-r".into(),
                        "-z".into(),
                        "--full-tree".into(),
                        head,
                        "--".into(),
                    ],
                    false,
                )
                .await?;
            let entries = parse::tree_entries(&bytes)?;
            let config = entries
                .iter()
                .find(|entry| entry.path == ".gitmodules" && entry.kind == "blob")
                .map(|entry| entry.oid.clone());
            let links: BTreeMap<_, _> = entries
                .into_iter()
                .filter(|entry| entry.mode == "160000")
                .map(|entry| (entry.path, entry.oid))
                .collect();
            (links, config)
        } else {
            let bytes = self
                .run_bytes(
                    repo,
                    request_id,
                    vec!["ls-files".into(), "--stage".into(), "-z".into()],
                    false,
                )
                .await?;
            let entries = parse::index_entries(&bytes)?;
            let config = entries
                .iter()
                .find(|entry| {
                    entry.path == ".gitmodules" && entry.stage == 0 && entry.mode != "120000"
                })
                .map(|entry| entry.oid.clone());
            let mut links = BTreeMap::new();
            // Stage 2 is the local-side gitlink when the index is unmerged.
            for entry in entries
                .iter()
                .filter(|entry| entry.mode == "160000" && entry.stage == 2)
            {
                links.insert(entry.path.clone(), entry.oid.clone());
            }
            for entry in entries
                .into_iter()
                .filter(|entry| entry.mode == "160000" && entry.stage == 0)
            {
                links.insert(entry.path, entry.oid);
            }
            (links, config)
        };
        if gitlinks.len() > SUBMODULE_LIMIT {
            return Err(AppError::new(
                "SUBMODULE_LIMIT",
                "Submodule inspection supports at most 256 direct submodules",
            ));
        }
        if gitlinks.is_empty() {
            return Ok(Vec::new());
        }
        let mut names: BTreeMap<String, (String, String)> = BTreeMap::new();
        if let Some(oid) = modules_oid {
            self.check_small_object(repo, request_id, &oid).await?;
            // Read the index/HEAD blob rather than following an arbitrary worktree
            // .gitmodules symlink or include directive. --includes is not enabled.
            let bytes = self
                .run_bytes(
                    repo,
                    request_id,
                    vec![
                        "config".into(),
                        "--null".into(),
                        "--list".into(),
                        "--no-includes".into(),
                        format!("--blob={oid}"),
                    ],
                    false,
                )
                .await?;
            for entry in unscoped_config(&bytes)? {
                let Some(rest) = entry.key.strip_prefix("submodule.") else {
                    continue;
                };
                let Some((name, property)) = rest.rsplit_once('.') else {
                    continue;
                };
                if name.is_empty() || name.chars().any(char::is_control) {
                    return Err(invalid("Invalid submodule name"));
                }
                let value = entry.value.unwrap_or_default();
                let item = names.entry(name.into()).or_default();
                if property == "path" {
                    validate_path(&value)?;
                    item.0 = value;
                } else if property == "url" {
                    item.1 = value;
                }
            }
        }
        let mut by_path = BTreeMap::new();
        for (name, (path, url)) in names {
            if path.is_empty() {
                continue;
            }
            if by_path.insert(path, (name, url)).is_some() {
                return Err(invalid("Duplicate submodule path in .gitmodules"));
            }
        }
        let mut result = Vec::new();
        for (path, index_oid) in gitlinks {
            validate_path(&path)?;
            let (name, url) = by_path
                .remove(&path)
                .unwrap_or_else(|| (path.clone(), String::new()));
            let mut info = SubmoduleInfo {
                path: path.clone(),
                name,
                url,
                initialized: false,
                head: None,
                index_oid: Some(index_oid.clone()),
                modified: false,
                untracked: false,
            };
            if !repo.bare {
                if let Some(root) = submodule_root(repo, &path)? {
                    let mut nested = repo.clone();
                    nested.path = root.to_string_lossy().into_owned();
                    nested.bare = false;
                    // rev-parse must identify this exact worktree, not discover its
                    // superproject when the submodule has not been initialized.
                    let top = self
                        .run(
                            &nested,
                            request_id,
                            vec!["rev-parse".into(), "--show-toplevel".into()],
                            false,
                        )
                        .await?;
                    if fs::canonicalize(top.trim()).map_err(io_error)? != root {
                        return Err(invalid(
                            "Submodule Git marker resolves to a different worktree",
                        ));
                    }
                    info.initialized = true;
                    info.head = self.optional_head(&nested, request_id).await?;
                    let status = self
                        .run_bytes(
                            &nested,
                            request_id,
                            vec![
                                "status".into(),
                                "--porcelain=v2".into(),
                                "-z".into(),
                                "--untracked-files=all".into(),
                                "--ignore-submodules=all".into(),
                            ],
                            false,
                        )
                        .await?;
                    let status = parse::working_state(&status)?;
                    info.untracked = status.files.iter().any(|file| file.status == "?");
                    info.modified = info.head.as_deref() != Some(&index_oid)
                        || status.files.iter().any(|file| file.status != "?");
                }
            }
            result.push(info);
        }
        Ok(result)
    }
}

fn unscoped_config(bytes: &[u8]) -> Result<Vec<parse::ConfigEntry>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let records = bytes
        .strip_suffix(&[0])
        .ok_or_else(|| invalid("Truncated .gitmodules configuration"))?;
    let mut scoped = Vec::new();
    for record in records.split(|byte| *byte == 0) {
        scoped.extend_from_slice(b"local\0");
        scoped.extend_from_slice(record);
        scoped.push(0);
    }
    parse::config(&scoped)
}

fn submodule_root(repo: &Repository, relative: &str) -> Result<Option<PathBuf>> {
    validate_path(relative)?;
    let base = fs::canonicalize(&repo.path).map_err(io_error)?;
    let mut current = base.clone();
    for component in relative.split('/') {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        reject_link(&metadata)?;
        if !metadata.is_dir() {
            return Err(argument("A submodule worktree path is not a directory"));
        }
        let canonical = fs::canonicalize(&current).map_err(io_error)?;
        if !canonical.starts_with(&base) {
            return Err(argument("Submodule resolves outside the repository"));
        }
    }
    let marker = current.join(".git");
    match fs::symlink_metadata(marker) {
        Ok(metadata) => {
            reject_link(&metadata)?;
            if !metadata.is_dir() && !metadata.is_file() {
                return Err(argument("Invalid submodule Git marker"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    }
    Ok(Some(fs::canonicalize(current).map_err(io_error)?))
}

fn reject_link(metadata: &fs::Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() {
        return Err(argument(
            "Submodule inspection does not follow worktree symlinks",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(argument(
                "Submodule inspection does not follow worktree reparse points",
            ));
        }
    }
    Ok(())
}
