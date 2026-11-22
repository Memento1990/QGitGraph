use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub git_dir: String,
    pub common_dir: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub trusted: bool,
    pub bare: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub kind: String,
    pub upstream: Option<String>,
    pub current: bool,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub authored_at: i64,
    pub committed_at: i64,
    pub subject: String,
    pub refs: Vec<GitRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_parents: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_head: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub repo_id: String,
    pub request_id: String,
    pub offset: usize,
    pub limit: usize,
    pub revision: Option<String>,
    pub search: Option<String>,
    pub search_mode: Option<String>,
    pub order: Option<String>,
    pub first_parent: Option<bool>,
    pub include_reflog: Option<bool>,
    pub show_remotes: Option<bool>,
    pub show_tags: Option<bool>,
    pub show_stashes: Option<bool>,
    pub mailmap: Option<bool>,
    pub scope: Option<HistoryScope>,
    pub include_tag_only: Option<bool>,
    pub show_remote_heads: Option<bool>,
    pub collapse_stash_auxiliary: Option<bool>,
    pub mark_head_ancestry: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<Commit>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub staged: bool,
    pub unstaged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submodule: Option<SubmoduleStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingState {
    pub files: Vec<ChangedFile>,
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub operation: Option<String>,
    pub conflicts: usize,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Signature {
    pub status: String,
    pub signer: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: Commit,
    pub body: String,
    pub committer: String,
    pub committer_email: String,
    pub signature: Signature,
    pub files: Vec<ChangedFile>,
    pub base: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonQuery {
    pub repo_id: String,
    pub request_id: String,
    pub base: Option<String>,
    pub target: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffQuery {
    pub repo_id: String,
    pub request_id: String,
    pub base: Option<String>,
    pub target: String,
    pub path: String,
    pub old_path: Option<String>,
    pub context: Option<usize>,
    pub encoding: Option<String>,
    pub staged: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stash {
    pub selector: String,
    pub oid: String,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    pub user_name: String,
    pub user_email: String,
    pub global_user_name: String,
    pub global_user_email: String,
    pub signing_key: String,
    pub sign_commits: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAction {
    pub repo_id: String,
    pub request_id: String,
    pub kind: String,
    pub target: Option<String>,
    pub name: Option<String>,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub url: Option<String>,
    pub message: Option<String>,
    pub email: Option<String>,
    pub mode: Option<String>,
    pub force: Option<bool>,
    pub no_commit: Option<bool>,
    pub no_fast_forward: Option<bool>,
    pub squash: Option<bool>,
    pub sign: Option<bool>,
    pub include_untracked: Option<bool>,
    pub include_ignored: Option<bool>,
    pub global: Option<bool>,
    pub interactive: Option<bool>,
    pub set_upstream: Option<bool>,
    pub checkout_after: Option<bool>,
    pub tag_type: Option<String>,
    pub push_after: Option<bool>,
    pub reinstate_index: Option<bool>,
    pub record_origin: Option<bool>,
    pub ignore_date: Option<bool>,
    pub prune: Option<bool>,
    pub prune_tags: Option<bool>,
    pub preserve_merges: Option<bool>,
    pub squash_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub output: String,
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: String,
    pub git_version: Option<String>,
    pub git_path: Option<String>,
    pub platform: String,
    pub config_directory: Option<String>,
    pub warnings: Vec<String>,
    pub performance_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub version: u32,
    pub recent: Vec<RecentRepo>,
    pub last_repo: Option<String>,
    pub trusted: Vec<String>,
    pub settings: serde_json::Value,
    pub repo_settings: HashMap<String, serde_json::Value>,
    pub reviews: Vec<serde_json::Value>,
    pub layout: serde_json::Value,
    #[serde(default)]
    pub views: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryScope {
    pub kind: String,
    pub refs: Option<Vec<String>>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleStatus {
    pub commit_changed: bool,
    pub modified: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub repository: Repository,
    pub refs: Vec<GitRef>,
    pub working: WorkingState,
    pub stashes: Vec<Stash>,
    pub remotes: Vec<Remote>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDetail {
    pub selector: String,
    pub oid: String,
    pub base: String,
    pub index: String,
    pub untracked: Option<String>,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDetail {
    pub name: String,
    pub r#ref: String,
    pub oid: String,
    pub target_oid: String,
    pub target_type: String,
    pub annotated: bool,
    pub tagger: String,
    pub email: String,
    pub timestamp: Option<i64>,
    pub message: String,
    pub signature: Signature,
}

#[derive(Debug, Clone, Serialize)]
pub struct Containment {
    pub oid: String,
    pub head: bool,
    pub refs: Vec<GitRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub path: String,
    pub name: String,
    pub url: String,
    pub initialized: bool,
    pub head: Option<String>,
    pub index_oid: Option<String>,
    pub modified: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyQuery {
    pub repo_id: String,
    pub request_id: String,
    pub kind: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub kind: String,
    pub oid: String,
    pub status: String,
    pub signer: String,
    pub key: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    pub id: String,
    pub repo_id: String,
    pub kind: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub operation: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveQuery {
    pub repo_id: String,
    pub request_id: String,
    pub target: String,
    pub format: String,
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImport {
    pub version: u32,
    pub settings: serde_json::Value,
    pub warnings: Vec<String>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: 2,
            recent: vec![],
            last_repo: None,
            trusted: vec![],
            settings: serde_json::json!({}),
            repo_settings: HashMap::new(),
            reviews: vec![],
            layout: serde_json::json!({"detailSize":360,"fileSize":260}),
            views: HashMap::new(),
        }
    }
}
