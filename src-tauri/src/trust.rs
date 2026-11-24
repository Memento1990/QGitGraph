use crate::{
    authority::PathIdentity,
    error::{AppError, Result},
    model::{NativeTrustState, Repository, RepositoryTrust, RepositoryTrustDecision, TrustRule},
    state::display_path,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RuleKind {
    Directory,
    Repository,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRule {
    path: String,
    kind: RuleKind,
    allow: bool,
    identity: PathIdentity,
    #[serde(default)]
    repository_identity: Option<crate::authority::RepositoryIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRules {
    version: u32,
    rules: Vec<StoredRule>,
}

impl Default for StoredRules {
    fn default() -> Self {
        Self {
            version: 1,
            rules: Vec::new(),
        }
    }
}

pub(crate) struct TrustService {
    file: PathBuf,
    rules: Mutex<StoredRules>,
}

impl TrustService {
    pub(crate) fn load(directory: &Path, legacy: &[String], warnings: &mut Vec<String>) -> Self {
        let file = directory.join("native-trust.json");
        let loaded = (|| -> Result<StoredRules> {
            if fs::metadata(&file).map_err(AppError::io)?.len() > 1024 * 1024 {
                return Err(AppError::new("TRUST", "Native trust rules exceed 1 MiB."));
            }
            let rules: StoredRules =
                serde_json::from_slice(&fs::read(&file).map_err(AppError::io)?)
                    .map_err(AppError::io)?;
            if rules.version != 1 || rules.rules.len() > 4096 {
                return Err(AppError::new("TRUST", "Unsupported native trust rules."));
            }
            for rule in &rules.rules {
                crate::discovery::validate_native_path(&rule.path)?;
                if !Path::new(&rule.path).is_absolute()
                    || rule.kind == RuleKind::Directory && !rule.allow
                {
                    return Err(AppError::new("TRUST", "Invalid native trust rule."));
                }
            }
            Ok(rules)
        })();
        let mut rules = StoredRules::default();
        let mut migrate = false;
        match loaded {
            Ok(value) => rules = value,
            Err(_) if !file.exists() => {
                migrate = !legacy.is_empty();
                // 仅本机启动时迁移旧版本逐仓授权，绝不从 save_state/import 迁移。
                for path in legacy {
                    if let Ok(selected) = crate::discovery::select_directory(path, None, &mut || Ok(())) {
                        if let Ok(identity) = PathIdentity::directory(&selected.path) {
                            let path = display_path(&selected.path);
                            if !rules.rules.iter().any(|rule| rule.path == path) {
                                if let Ok(repository_identity) = crate::authority::RepositoryIdentity::legacy_repository(&selected.path) {
                                    rules.rules.push(StoredRule { path, kind: RuleKind::Repository, allow: true, identity, repository_identity: Some(repository_identity) });
                                }
                            }
                        }
                    }
                }
            }
            Err(error) => warnings.push(format!("Native trust rules were not loaded; all repositories require renewed authorization: {error}")),
        }
        let service = Self {
            file,
            rules: Mutex::new(rules),
        };
        if migrate {
            let result = service.write(&service.rules.lock().unwrap());
            if let Err(error) = result {
                warnings.push(format!("Could not persist migrated native trust rules; authorization was not restored: {error}"));
                service.rules.lock().unwrap().rules.clear();
            }
        }
        service
    }

    fn write(&self, rules: &StoredRules) -> Result<()> {
        crate::settings::write_native_json(
            &self.file,
            &serde_json::to_vec_pretty(rules).map_err(AppError::io)?,
        )
    }

    pub(crate) fn repository_rule(
        &self,
        repo: &Repository,
        decision: RepositoryTrustDecision,
    ) -> Result<()> {
        let selected = crate::discovery::select_directory(&repo.path, None, &mut || Ok(()))?;
        if display_path(&selected.path) != repo.path {
            return Err(AppError::new(
                "AUTHORIZATION_CHANGED",
                "Repository path changed; reopen it before editing trust.",
            ));
        }
        let identity = PathIdentity::directory(&selected.path)?;
        self.change(
            StoredRule {
                path: repo.path.clone(),
                kind: RuleKind::Repository,
                allow: decision == RepositoryTrustDecision::Allow,
                identity,
                repository_identity: if repo.git_dir.is_empty() {
                    None
                } else {
                    Some(crate::authority::RepositoryIdentity::capture(repo)?.0)
                },
            },
            decision == RepositoryTrustDecision::Inherit,
        )
    }

    pub(crate) fn directory_rule(&self, path: &str, trusted: bool) -> Result<()> {
        let selected = crate::discovery::select_directory(path, None, &mut || Ok(()))?;
        let identity = PathIdentity::directory(&selected.path)?;
        self.change(
            StoredRule {
                path: display_path(&selected.path),
                kind: RuleKind::Directory,
                allow: true,
                identity,
                repository_identity: None,
            },
            !trusted,
        )
    }

    fn change(&self, rule: StoredRule, remove: bool) -> Result<()> {
        let mut rules = self.rules.lock().unwrap();
        let mut next = rules.clone();
        next.rules
            .retain(|old| old.kind != rule.kind || old.path != rule.path);
        if !remove {
            next.rules.push(rule);
        }
        if next.rules.len() > 4096 {
            return Err(AppError::new("TRUST", "Too many native trust rules."));
        }
        self.write(&next)?;
        *rules = next;
        Ok(())
    }

    pub(crate) fn decision(&self, repo: &Repository) -> (bool, &'static str, Option<String>) {
        let rules = self.rules.lock().unwrap();
        // 单仓 deny 是显式撤销，不因父目录增删或更深 grant 而失效。
        if let Some(rule) = rules
            .rules
            .iter()
            .find(|rule| rule.kind == RuleKind::Repository && rule.path == repo.path && !rule.allow)
        {
            return (false, "repository-deny", Some(rule.path.clone()));
        }
        if let Some(rule) = rules
            .rules
            .iter()
            .find(|rule| rule.kind == RuleKind::Repository && rule.path == repo.path && rule.allow)
        {
            if rule.identity.matches(Path::new(&repo.path))
                && rule
                    .repository_identity
                    .as_ref()
                    .is_none_or(|identity| identity.validate(repo).is_ok())
            {
                return (true, "repository-allow", Some(rule.path.clone()));
            }
        }
        let root = fs::canonicalize(&repo.path).ok();
        let mut matching: Vec<_> = rules
            .rules
            .iter()
            .filter(|rule| rule.kind == RuleKind::Directory && rule.allow)
            .collect();
        matching.sort_by_key(|rule| std::cmp::Reverse(Path::new(&rule.path).components().count()));
        if let Some(root) = root {
            for rule in matching {
                let Ok(scope) = fs::canonicalize(&rule.path) else {
                    continue;
                };
                if !root.starts_with(&scope) || !rule.identity.matches(Path::new(&rule.path)) {
                    continue;
                }
                // 复用 discovery 的逐组件 canonical/reparse/marker 检查；不做字符串前缀匹配。
                if let Ok(selected) =
                    crate::discovery::select_directory(&repo.path, Some(&rule.path), &mut || Ok(()))
                {
                    if selected.path == root {
                        return (true, "directory", Some(rule.path.clone()));
                    }
                }
            }
        }
        (false, "none", None)
    }

    pub(crate) fn snapshot(&self, repositories: Vec<RepositoryTrust>) -> NativeTrustState {
        let mut rules: Vec<_> = self
            .rules
            .lock()
            .unwrap()
            .rules
            .iter()
            .map(|rule| TrustRule {
                path: rule.path.clone(),
                kind: match rule.kind {
                    RuleKind::Directory => "directory",
                    RuleKind::Repository => "repository",
                }
                .into(),
                decision: if rule.allow { "allow" } else { "deny" }.into(),
            })
            .collect();
        rules.sort_by(|a, b| a.path.cmp(&b.path).then(a.kind.cmp(&b.kind)));
        NativeTrustState {
            version: 1,
            rules,
            repositories,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(root: &Path) -> Repository {
        fs::create_dir_all(root.join(".git")).unwrap();
        let path = display_path(&fs::canonicalize(root).unwrap());
        Repository {
            id: path.clone(),
            path: path.clone(),
            name: "Trust fixture".into(),
            git_dir: Path::new(&path).join(".git").to_string_lossy().into_owned(),
            common_dir: Path::new(&path).join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: None,
            trusted: false,
            bare: false,
        }
    }

    #[test]
    fn directory_grants_are_component_bounded_deny_wins_and_inherit_restores_after_restart() {
        let fixture = tempfile::tempdir().unwrap();
        let parent = fixture.path().join("scope");
        let first = repo(&parent.join("first"));
        let second = repo(&parent.join("nested/second"));
        let adjacent = repo(&fixture.path().join("scope-adjacent/repository"));
        let profile = fixture.path().join("profile");
        let mut warnings = Vec::new();
        let service = TrustService::load(&profile, &[], &mut warnings);
        service
            .directory_rule(parent.to_str().unwrap(), true)
            .unwrap();
        assert_eq!(service.decision(&first).1, "directory");
        assert!(service.decision(&second).0);
        assert!(!service.decision(&adjacent).0);
        service
            .repository_rule(&first, RepositoryTrustDecision::Deny)
            .unwrap();
        service.directory_rule(&first.path, true).unwrap();
        assert_eq!(service.decision(&first).1, "repository-deny");
        assert!(service.decision(&second).0);
        let service = TrustService::load(&profile, &[], &mut warnings);
        assert_eq!(service.decision(&first).1, "repository-deny");
        assert!(service.decision(&second).0);
        service
            .repository_rule(&first, RepositoryTrustDecision::Inherit)
            .unwrap();
        assert_eq!(service.decision(&first).1, "directory");
        service.directory_rule(&first.path, false).unwrap();
        service
            .directory_rule(parent.to_str().unwrap(), false)
            .unwrap();
        assert!(!service.decision(&first).0);
        assert!(!service.decision(&second).0);
        assert!(warnings.is_empty());
        assert!(!profile.join("state.json").exists());
    }

    #[test]
    fn native_legacy_migration_runs_once_and_damaged_native_rules_never_restore_legacy_trust() {
        let fixture = tempfile::tempdir().unwrap();
        let repository = repo(&fixture.path().join("repository"));
        let profile = fixture.path().join("profile");
        let mut warnings = Vec::new();
        let service = TrustService::load(
            &profile,
            std::slice::from_ref(&repository.path),
            &mut warnings,
        );
        assert_eq!(service.decision(&repository).1, "repository-allow");
        service
            .repository_rule(&repository, RepositoryTrustDecision::Deny)
            .unwrap();
        let service = TrustService::load(
            &profile,
            std::slice::from_ref(&repository.path),
            &mut warnings,
        );
        assert_eq!(service.decision(&repository).1, "repository-deny");
        fs::write(profile.join("native-trust.json"), b"{ damaged").unwrap();
        let service = TrustService::load(
            &profile,
            std::slice::from_ref(&repository.path),
            &mut warnings,
        );
        assert!(!service.decision(&repository).0);
        assert!(!warnings.is_empty());
        assert_eq!(
            fs::read(profile.join("native-trust.json")).unwrap(),
            b"{ damaged"
        );
    }

    #[test]
    fn replacement_directory_or_git_administration_never_inherits_an_old_explicit_allow() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("repository");
        let repository = repo(&root);
        let profile = fixture.path().join("profile");
        let service = TrustService::load(&profile, &[], &mut Vec::new());
        service
            .repository_rule(&repository, RepositoryTrustDecision::Allow)
            .unwrap();
        assert!(service.decision(&repository).0);
        fs::rename(root.join(".git"), root.join("old-git")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        assert!(!service.decision(&repository).0);
        fs::remove_dir(root.join(".git")).unwrap();
        fs::rename(root.join("old-git"), root.join(".git")).unwrap();
        assert!(service.decision(&repository).0);
        fs::rename(&root, fixture.path().join("old-repository")).unwrap();
        let replacement = repo(&root);
        assert!(!service.decision(&replacement).0);
    }

    #[cfg(windows)]
    #[test]
    fn directory_junction_to_outside_never_inherits_parent_grant() {
        let fixture = tempfile::tempdir().unwrap();
        let parent = fixture.path().join("scope");
        fs::create_dir(&parent).unwrap();
        let outside_root = fixture.path().join("outside").join("repository");
        let outside = repo(&outside_root);
        let link = parent.join("linked");
        let cmd = PathBuf::from(std::env::var_os("WINDIR").unwrap())
            .join("System32")
            .join("cmd.exe");
        let status = std::process::Command::new(cmd)
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside_root)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let service = TrustService::load(&fixture.path().join("profile"), &[], &mut Vec::new());
        service
            .directory_rule(parent.to_str().unwrap(), true)
            .unwrap();
        assert!(!service.decision(&outside).0);
        let mut lexical = outside.clone();
        lexical.path = display_path(&link);
        assert!(!service.decision(&lexical).0);
        fs::remove_dir(link).unwrap();
    }

    #[test]
    fn failed_persistence_keeps_previous_rules_and_does_not_grant_new_authority() {
        let fixture = tempfile::tempdir().unwrap();
        let repository = repo(&fixture.path().join("repository"));
        let profile = fixture.path().join("profile");
        fs::create_dir_all(profile.join("native-trust.json.tmp")).unwrap();
        let service = TrustService::load(&profile, &[], &mut Vec::new());
        assert!(service
            .repository_rule(&repository, RepositoryTrustDecision::Allow)
            .is_err());
        assert!(!service.decision(&repository).0);
        assert!(service.snapshot(Vec::new()).rules.is_empty());
    }
}
