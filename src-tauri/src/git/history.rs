//! Bounded, read-only history selection. User globs are matched locally against
//! enumerated full ref names; Git receives only verified full object IDs on stdin.

use std::collections::{HashMap, HashSet};

use super::{argument, attach_refs, validate_revision, DateRange, LOG_FORMAT, LOG_FORMAT_MAILMAP};
use crate::{
    error::{AppError, Result},
    git::{parse, GitService},
    model::{GitRef, HistoryPage, HistoryQuery, HistoryScope, Repository},
    performance::Span,
};

pub(super) const REF_LIMIT: usize = 20_000;
const SCAN_LIMIT: usize = 100_000;
const BATCH: usize = 500;
const PATTERN_LIMIT: usize = 256;
const MATCH_BUDGET: usize = 8_000_000;
const AUXILIARY_PROBE_LIMIT: usize = 1024;

fn limit(message: &str) -> AppError {
    AppError::new("HISTORY_LIMIT", message)
}

// Keep early pages small, but make repeated --skip traversals linear in the
// examined prefix rather than quadratic. A wide response that exceeds the
// runner's output bound retries at the SAME offset and stays at small batches.
struct ScanWindow {
    offset: usize,
    size: usize,
    small_batches: bool,
}

impl ScanWindow {
    fn new() -> Self {
        Self {
            offset: 0,
            size: BATCH,
            small_batches: false,
        }
    }

    fn retry_small(&mut self) -> bool {
        if self.size <= BATCH {
            return false;
        }
        self.size = BATCH;
        self.small_batches = true;
        true
    }

    fn advance(&mut self) {
        self.offset += self.size;
        self.size = if self.small_batches {
            BATCH
        } else {
            self.size.saturating_mul(4)
        }
        .min(SCAN_LIMIT - self.offset);
    }
}

pub(super) fn oid_input(tips: &[String]) -> Result<Vec<u8>> {
    if tips.len() > SCAN_LIMIT {
        return Err(limit("History selection exceeds 100000 object IDs"));
    }
    let mut input = Vec::with_capacity(tips.len().saturating_mul(65));
    for oid in tips {
        if !matches!(oid.len(), 40 | 64) || !parse::is_oid(oid) {
            return Err(AppError::new(
                "GIT_PARSE",
                "Expected a full SHA-1/SHA-256 object ID",
            ));
        }
        input.extend_from_slice(oid.as_bytes());
        input.push(b'\n');
    }
    Ok(input)
}

fn remote_head(item: &GitRef) -> bool {
    item.kind == "remote" && item.full_name.ends_with("/HEAD")
}

fn visible(item: &GitRef, q: &HistoryQuery) -> bool {
    match item.kind.as_str() {
        "remote" => {
            q.show_remotes.unwrap_or(true)
                && (q.show_remote_heads.unwrap_or(false) || !remote_head(item))
        }
        "tag" => q.show_tags.unwrap_or(true),
        "stash" => q.show_stashes.unwrap_or(true),
        _ => true,
    }
}

fn empty_page() -> HistoryPage {
    HistoryPage {
        commits: Vec::new(),
        has_more: false,
    }
}

/// Supported glob syntax is `*` (including `/`) and `?` (one Unicode scalar).
/// No regex, character class, escape, revision syntax, or Git option is evaluated.
struct Glob(Vec<char>);
impl Glob {
    fn new(pattern: &str) -> Result<Self> {
        if pattern.is_empty()
            || pattern.len() > 1024
            || !(pattern.starts_with("refs/") || pattern == "HEAD")
            || pattern
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || "[]\\:^~".contains(c))
            || pattern.contains("..")
            || pattern.contains("@{")
        {
            return Err(argument(
                "Use a full refs/... glob with only * and ? wildcards",
            ));
        }
        Ok(Self(pattern.chars().collect()))
    }

    fn matches(&self, value: &str, budget: &mut usize) -> Result<bool> {
        let text: Vec<char> = value.chars().collect();
        let (mut p, mut t, mut star, mut retry) = (0usize, 0usize, None, 0usize);
        while t < text.len() {
            if *budget == 0 {
                return Err(limit(
                    "Ref glob matching exceeded its work budget; narrow the patterns",
                ));
            }
            *budget -= 1;
            if p < self.0.len() && (self.0[p] == '?' || self.0[p] == text[t]) {
                p += 1;
                t += 1;
            } else if p < self.0.len() && self.0[p] == '*' {
                star = Some(p);
                p += 1;
                retry = t;
            } else if let Some(index) = star {
                retry += 1;
                t = retry;
                p = index + 1;
            } else {
                return Ok(false);
            }
        }
        while p < self.0.len() && self.0[p] == '*' {
            p += 1;
        }
        Ok(p == self.0.len())
    }
}

fn compile_patterns(values: Option<&Vec<String>>) -> Result<Vec<Glob>> {
    let values = values.map(Vec::as_slice).unwrap_or(&[]);
    if values.len() > PATTERN_LIMIT || values.iter().map(String::len).sum::<usize>() > 65536 {
        return Err(argument(
            "A ref scope accepts at most 256 globs and 64 KiB of pattern text",
        ));
    }
    values.iter().map(|value| Glob::new(value)).collect()
}

struct Selection {
    tips: Vec<String>,
    sources: HashSet<String>,
    all: bool,
}

fn source_name(item: &GitRef) -> Option<&str> {
    if item.kind != "stash" {
        Some(&item.full_name)
    } else if item.name == "stash@{0}" {
        Some("refs/stash")
    } else {
        None
    }
}

impl GitService {
    pub async fn history(&self, repo: &Repository, q: HistoryQuery) -> Result<HistoryPage> {
        self.check_request(&q.request_id)?;
        if q.limit == 0 || q.limit > 1000 || q.offset > SCAN_LIMIT {
            return Err(argument(
                "History limit must be 1..1000 and offset at most 100000",
            ));
        }
        let order = match q.order.as_deref().unwrap_or("topo") {
            "topo" => "--topo-order",
            "date" => "--date-order",
            "author-date" => "--author-date-order",
            _ => return Err(argument("Unknown history ordering")),
        };
        let mode = q.search_mode.as_deref().unwrap_or("all");
        if !matches!(
            mode,
            "all" | "message" | "author" | "hash" | "date" | "refs"
        ) {
            return Err(argument("Unknown history search mode"));
        }
        let search = q.search.as_deref().unwrap_or("").trim();
        if search.len() > 1024 || search.contains('\0') {
            return Err(argument("Search is too long or contains NUL"));
        }
        let date = if mode == "date" && !search.is_empty() {
            Some(DateRange::parse(search)?)
        } else {
            None
        };
        let all_refs = self.refs(repo, &q.request_id).await?;
        if all_refs.len() > REF_LIMIT {
            return Err(limit("Repository has more than 20000 graph refs/stashes"));
        }
        let head = self.optional_head(repo, &q.request_id).await?;
        let mut selection = self
            .history_selection(repo, &q, &all_refs, head.as_deref())
            .await?;
        self.check_request(&q.request_id)?;
        // Empty explicit scopes must not accidentally become HEAD/all/reflog.
        if selection.tips.is_empty() && !selection.all {
            return Ok(empty_page());
        }
        if q.include_reflog.unwrap_or(false) {
            self.add_history_reflog(repo, &q, &mut selection).await?;
        }
        self.check_request(&q.request_id)?;
        let mut seen = HashSet::new();
        selection.tips.retain(|oid| seen.insert(oid.clone()));
        if selection.tips.is_empty() {
            return Ok(empty_page());
        }
        let input = oid_input(&selection.tips)?;
        let visible_refs: Vec<_> = all_refs
            .iter()
            .filter(|item| visible(item, &q))
            .cloned()
            .collect();
        let needle = search.to_lowercase();
        let matching_labels: HashSet<_> = if !search.is_empty() && matches!(mode, "all" | "refs") {
            all_refs
                .iter()
                .filter(|item| {
                    item.name.to_lowercase().contains(&needle)
                        || item.full_name.to_lowercase().contains(&needle)
                })
                .map(|item| item.oid.clone())
                .collect()
        } else {
            HashSet::new()
        };
        self.check_request(&q.request_id)?;
        if mode == "refs" && !search.is_empty() && matching_labels.is_empty() {
            return Ok(empty_page());
        }

        let collapse = q.collapse_stash_auxiliary.unwrap_or(false);
        let stash_tips: Vec<_> = all_refs
            .iter()
            .filter(|item| item.kind == "stash")
            .map(|item| item.oid.clone())
            .collect();
        let stash_ids: HashSet<_> = stash_tips.iter().cloned().collect();
        let stash_records = if collapse && !stash_tips.is_empty() {
            let bytes = self
                .run_with_input(
                    repo,
                    &q.request_id,
                    vec![
                        "log".into(),
                        "-z".into(),
                        format!("--format={LOG_FORMAT}"),
                        "--no-walk=unsorted".into(),
                        "--no-show-signature".into(),
                        "--no-decorate".into(),
                        "--no-notes".into(),
                        "--stdin".into(),
                        "--".into(),
                    ],
                    oid_input(&stash_tips)?,
                    false,
                )
                .await?;
            parse::log(&bytes)?
        } else {
            Vec::new()
        };
        let auxiliary: HashSet<_> = stash_records
            .iter()
            .filter(|commit| matches!(commit.parents.len(), 2 | 3))
            .flat_map(|commit| commit.parents.iter().skip(1).cloned())
            .collect();
        let mut protection = HashMap::<String, bool>::new();
        let mut hidden = HashSet::<String>::new();
        let head_ancestry = if q.mark_head_ancestry.unwrap_or(false) {
            match &head {
                Some(oid) => {
                    self.history_ancestry(repo, &q.request_id, std::slice::from_ref(oid))
                        .await?
                }
                None => HashSet::new(),
            }
        } else {
            HashSet::new()
        };
        let format = if q.mailmap.unwrap_or(true) {
            LOG_FORMAT_MAILMAP
        } else {
            LOG_FORMAT
        };
        let mut args = vec![
            "-c".into(),
            "i18n.logOutputEncoding=UTF-8".into(),
            "log".into(),
            "-z".into(),
            format!(
                "--format={format}{}",
                if mode == "all" && !search.is_empty() {
                    "%x00%b"
                } else {
                    ""
                }
            ),
            "--no-show-signature".into(),
            "--no-color".into(),
            "--no-decorate".into(),
            "--no-notes".into(),
            order.into(),
        ];
        if q.first_parent.unwrap_or(false) {
            args.push("--first-parent".into());
        }
        if !search.is_empty() && matches!(mode, "message" | "author") {
            args.extend([
                "--fixed-strings".into(),
                "--regexp-ignore-case".into(),
                format!(
                    "--{}={search}",
                    if mode == "message" { "grep" } else { "author" }
                ),
            ]);
        }
        if let Some(date) = date {
            args.push(format!("--since-as-filter=@{}", date.start));
            args.push(format!("--until=@{}", date.end));
        }
        let manual_search = !search.is_empty() && matches!(mode, "all" | "hash" | "refs");
        let must_scan = manual_search || !auxiliary.is_empty();
        let mut matched = Vec::new();
        let mut window = ScanWindow::new();
        let mut count = 0usize;
        loop {
            self.check_request(&q.request_id)?;
            let mut batch_args = args.clone();
            batch_args.push(format!(
                "--skip={}",
                if must_scan { window.offset } else { q.offset }
            ));
            batch_args.push(format!(
                "--max-count={}",
                if must_scan { window.size } else { q.limit + 1 }
            ));
            batch_args.extend(["--stdin".into(), "--".into()]);
            let bytes = match self
                .run_with_input(repo, &q.request_id, batch_args, input.clone(), false)
                .await
            {
                // Widening is an optimization, not a stricter message-size
                // limit. Preserve formerly successful 500-row early returns.
                Err(error) if must_scan && error.code == "OUTPUT_LIMIT" && window.retry_small() => {
                    continue;
                }
                output => output?,
            };
            self.check_request(&q.request_id)?;
            let mut parse_span = Span::begin(&q.request_id, "parse", "log");
            let batch = if mode == "all" && !search.is_empty() {
                parse::search_log(&bytes)?
            } else {
                parse::log(&bytes)?
                    .into_iter()
                    .map(|commit| parse::SearchRecord {
                        commit,
                        body: String::new(),
                    })
                    .collect()
            };
            parse_span.complete();
            drop(parse_span);
            // Do not retain both the captured wire bytes and parsed messages
            // while CPU filtering or stash containment probes are in progress.
            drop(bytes);
            self.check_request(&q.request_id)?;
            let batch_len = batch.len();
            for (index, record) in batch.into_iter().enumerate() {
                if index % 128 == 0 {
                    self.check_request(&q.request_id)?;
                }
                let mut commit = record.commit;
                if collapse {
                    let mut candidates: Vec<_> = commit
                        .parents
                        .iter()
                        .filter(|oid| auxiliary.contains(*oid))
                        .cloned()
                        .collect();
                    if auxiliary.contains(&commit.oid) {
                        candidates.push(commit.oid.clone());
                    }
                    for candidate in candidates {
                        if !protection.contains_key(&candidate) {
                            if protection.len() >= AUXILIARY_PROBE_LIMIT {
                                return Err(limit("Stash projection examined more than 1024 auxiliary commits; disable collapse or narrow history"));
                            }
                            let mut kept = self
                                .auxiliary_has_ordinary_ref(
                                    repo,
                                    &q.request_id,
                                    &candidate,
                                    head.as_deref(),
                                )
                                .await?
                                || (selection.tips.contains(&candidate)
                                    && !stash_ids.contains(&candidate));
                            // An explicit dangling commit is also an ordinary
                            // history source; its ancestors were not introduced
                            // solely by displaying a stash.
                            if !kept && q.scope.is_none() && q.revision.is_some() {
                                for tip in &selection.tips {
                                    if !stash_ids.contains(tip)
                                        && self
                                            .oid_is_ancestor(repo, &q.request_id, &candidate, tip)
                                            .await?
                                    {
                                        kept = true;
                                        break;
                                    }
                                }
                            }
                            protection.insert(candidate.clone(), kept);
                            if !kept {
                                hidden.insert(candidate);
                            }
                        }
                    }
                    if hidden.contains(&commit.oid) {
                        continue;
                    }
                    let projected: Vec<_> = commit
                        .parents
                        .iter()
                        .filter(|oid| !hidden.contains(*oid))
                        .cloned()
                        .collect();
                    if projected != commit.parents {
                        commit.graph_parents = Some(projected);
                    }
                }
                let found = if !manual_search {
                    true
                } else {
                    match mode {
                        "refs" => matching_labels.contains(&commit.oid),
                        "hash" => commit.oid.to_lowercase().contains(&needle),
                        _ => {
                            commit.oid.to_lowercase().contains(&needle)
                                || commit.subject.to_lowercase().contains(&needle)
                                || record.body.to_lowercase().contains(&needle)
                                || commit.author.to_lowercase().contains(&needle)
                                || commit.email.to_lowercase().contains(&needle)
                                || matching_labels.contains(&commit.oid)
                        }
                    }
                };
                if found {
                    if !must_scan || count >= q.offset {
                        commit.node_kind = Some(
                            if stash_ids.contains(&commit.oid) {
                                "stash"
                            } else {
                                "commit"
                            }
                            .into(),
                        );
                        if q.mark_head_ancestry.unwrap_or(false) {
                            commit.in_head = Some(head_ancestry.contains(&commit.oid));
                        }
                        matched.push(commit);
                    }
                    count += 1;
                    if matched.len() > q.limit {
                        break;
                    }
                }
            }
            if !must_scan || matched.len() > q.limit || batch_len < window.size {
                break;
            }
            window.advance();
            if window.offset >= SCAN_LIMIT {
                return Err(AppError::new("SEARCH_LIMIT", "History filtering examined 100000 commits; narrow the scope/search or disable stash collapse"));
            }
        }
        self.check_request(&q.request_id)?;
        let has_more = matched.len() > q.limit;
        matched.truncate(q.limit);
        attach_refs(&mut matched, &visible_refs);
        Ok(HistoryPage {
            commits: matched,
            has_more,
        })
    }

    async fn history_selection(
        &self,
        repo: &Repository,
        q: &HistoryQuery,
        refs: &[GitRef],
        head: Option<&str>,
    ) -> Result<Selection> {
        let mut result = Selection {
            tips: Vec::new(),
            sources: HashSet::new(),
            all: false,
        };
        let scope = q.scope.as_ref();
        let kind = scope.map(|scope| scope.kind.as_str());
        if scope.is_none() {
            if let Some(revision) = &q.revision {
                if revision == "HEAD" {
                    if let Some(oid) = head {
                        result.tips.push(oid.into());
                        result.sources.insert("HEAD".into());
                    }
                } else {
                    result
                        .tips
                        .push(self.resolve_revision(repo, &q.request_id, revision).await?);
                    result.sources.insert(revision.clone());
                }
                return Ok(result);
            }
        }
        match kind.unwrap_or("all") {
            "all" => {
                result.all = true;
                result.sources.insert("HEAD".into());
                if let Some(oid) = head {
                    result.tips.push(oid.into());
                }
                for (index, item) in refs.iter().enumerate() {
                    if index % 128 == 0 {
                        self.check_request(&q.request_id)?;
                    }
                    if visible(item, q)
                        && (item.kind != "tag" || q.include_tag_only.unwrap_or(true))
                    {
                        result.tips.push(item.oid.clone());
                        if let Some(name) = source_name(item) {
                            result.sources.insert(name.into());
                        }
                    }
                }
            }
            "head" => {
                result.sources.insert("HEAD".into());
                if let Some(oid) = head {
                    result.tips.push(oid.into());
                }
            }
            "refs" => {
                let names = scope
                    .and_then(|scope| scope.refs.as_ref())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                if names.len() > REF_LIMIT {
                    return Err(argument("A ref scope accepts at most 20000 exact refs"));
                }
                for (index, name) in names.iter().enumerate() {
                    if index % 128 == 0 {
                        self.check_request(&q.request_id)?;
                    }
                    validate_revision(name)?;
                    if !name.starts_with("refs/") {
                        return Err(argument("A refs scope requires exact full refs/... names"));
                    }
                }
                let wanted: HashSet<_> = names.iter().map(String::as_str).collect();
                for (index, item) in refs.iter().enumerate() {
                    if index % 128 == 0 {
                        self.check_request(&q.request_id)?;
                    }
                    if source_name(item).is_some_and(|name| wanted.contains(name)) {
                        result.tips.push(item.oid.clone());
                        result.sources.insert(source_name(item).unwrap().into());
                    }
                }
            }
            "glob" => {
                let HistoryScope {
                    include, exclude, ..
                } = scope.unwrap();
                let include = compile_patterns(include.as_ref())?;
                let exclude = compile_patterns(exclude.as_ref())?;
                let mut budget = MATCH_BUDGET;
                for (index, item) in refs.iter().enumerate() {
                    if index % 32 == 0 {
                        self.check_request(&q.request_id)?;
                    }
                    let Some(name) = source_name(item) else {
                        continue;
                    };
                    let mut included = false;
                    for pattern in &include {
                        if pattern.matches(name, &mut budget)? {
                            included = true;
                            break;
                        }
                    }
                    if !included {
                        continue;
                    }
                    for pattern in &exclude {
                        if pattern.matches(name, &mut budget)? {
                            included = false;
                            break;
                        }
                    }
                    if included {
                        result.tips.push(item.oid.clone());
                        result.sources.insert(name.into());
                    }
                }
            }
            _ => return Err(argument("Unknown history scope kind")),
        }
        Ok(result)
    }

    async fn add_history_reflog(
        &self,
        repo: &Repository,
        q: &HistoryQuery,
        selection: &mut Selection,
    ) -> Result<()> {
        let bytes = self
            .run_bytes(
                repo,
                &q.request_id,
                vec![
                    "reflog".into(),
                    "show".into(),
                    "--all".into(),
                    "-z".into(),
                    format!("--max-count={}", SCAN_LIMIT + 1),
                    "--format=tformat:%gD%x00%H".into(),
                    "--no-show-signature".into(),
                    "--no-notes".into(),
                ],
                false,
            )
            .await?;
        let mut fields = bytes.split(|b| *b == 0);
        let mut count = 0;
        loop {
            let Some(selector) = fields.next() else {
                break;
            };
            if selector.is_empty() && fields.clone().next().is_none() {
                break;
            }
            let oid = fields
                .next()
                .ok_or_else(|| AppError::new("GIT_PARSE", "Truncated reflog record"))?;
            count += 1;
            if count % 128 == 0 {
                self.check_request(&q.request_id)?;
            }
            if count > SCAN_LIMIT {
                return Err(limit("Reflog selection exceeds 100000 records"));
            }
            let selector = std::str::from_utf8(selector)
                .map_err(|_| AppError::new("GIT_PARSE", "Invalid reflog ref name"))?;
            let source = selector
                .rsplit_once("@{")
                .map(|(name, _)| name)
                .ok_or_else(|| AppError::new("GIT_PARSE", "Invalid reflog selector"))?;
            if selection.sources.contains(source) {
                let oid = std::str::from_utf8(oid)
                    .map_err(|_| AppError::new("GIT_PARSE", "Invalid reflog object ID"))?
                    .to_owned();
                oid_input(std::slice::from_ref(&oid))?;
                selection.tips.push(oid);
            }
        }
        Ok(())
    }

    pub(super) async fn history_ancestry(
        &self,
        repo: &Repository,
        request_id: &str,
        tips: &[String],
    ) -> Result<HashSet<String>> {
        if tips.is_empty() {
            return Ok(HashSet::new());
        }
        let bytes = self
            .run_with_input(
                repo,
                request_id,
                vec![
                    "log".into(),
                    "--format=%H".into(),
                    "--no-show-signature".into(),
                    "--no-notes".into(),
                    format!("--max-count={}", SCAN_LIMIT + 1),
                    "--stdin".into(),
                    "--".into(),
                ],
                oid_input(tips)?,
                false,
            )
            .await?;
        let output = std::str::from_utf8(&bytes)
            .map_err(|_| AppError::new("GIT_PARSE", "Invalid ancestry object ID"))?;
        let mut result = HashSet::new();
        for (index, line) in output.lines().enumerate() {
            if index % 128 == 0 {
                self.check_request(request_id)?;
            }
            let value = line.trim_end_matches('\r').to_owned();
            oid_input(std::slice::from_ref(&value))?;
            result.insert(value);
            if result.len() > SCAN_LIMIT {
                return Err(limit(
                    "HEAD ancestry exceeds 100000 commits; disable ancestry marking",
                ));
            }
        }
        Ok(result)
    }

    async fn auxiliary_has_ordinary_ref(
        &self,
        repo: &Repository,
        request_id: &str,
        oid: &str,
        head: Option<&str>,
    ) -> Result<bool> {
        let output = self
            .run(
                repo,
                request_id,
                vec![
                    "for-each-ref".into(),
                    format!("--contains={oid}"),
                    "--format=%(refname)".into(),
                    format!("--count={}", REF_LIMIT + 1),
                ],
                false,
            )
            .await?;
        if output.lines().count() > REF_LIMIT {
            return Err(limit("Auxiliary containment exceeds 20000 refs"));
        }
        for name in output.lines() {
            validate_revision(name)?;
            if name != "refs/stash" {
                return Ok(true);
            }
        }
        if let Some(head) = head {
            return self.oid_is_ancestor(repo, request_id, oid, head).await;
        }
        Ok(false)
    }

    pub(super) async fn oid_is_ancestor(
        &self,
        repo: &Repository,
        request_id: &str,
        oid: &str,
        tip: &str,
    ) -> Result<bool> {
        oid_input(&[oid.to_owned(), tip.to_owned()])?;
        // Unlike merge-base --is-ancestor, this has no expected exit-1 error
        // that might accidentally mask a corrupt object or cancelled request.
        let output = self
            .run(
                repo,
                request_id,
                vec![
                    "rev-list".into(),
                    "--max-count=1".into(),
                    oid.into(),
                    "--not".into(),
                    tip.into(),
                    "--".into(),
                ],
                false,
            )
            .await?;
        Ok(output.trim().is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_windows_are_contiguous_bounded_and_geometrically_growing() {
        let mut window = ScanWindow::new();
        let mut windows = Vec::new();
        let mut repeated_traversal = 0;
        while window.offset < SCAN_LIMIT {
            windows.push((window.offset, window.size));
            repeated_traversal += window.offset + window.size;
            window.advance();
        }
        assert_eq!(
            windows,
            vec![
                (0, 500),
                (500, 2000),
                (2500, 8000),
                (10500, 32000),
                (42500, 57500)
            ]
        );
        assert_eq!(window.offset, SCAN_LIMIT);
        assert_eq!(window.size, 0);
        assert!(repeated_traversal < 2 * SCAN_LIMIT);
        // 20k no-match histories finish on the fourth log rather than 41 logs.
        assert_eq!(
            windows
                .iter()
                .take_while(|(offset, _)| *offset < 20000)
                .count(),
            4
        );
    }

    #[test]
    fn wide_output_fallback_never_skips_or_repeatedly_retries_a_window() {
        let mut window = ScanWindow::new();
        assert!(!window.retry_small());
        window.advance();
        assert_eq!((window.offset, window.size), (500, 2000));
        assert!(window.retry_small());
        assert_eq!((window.offset, window.size), (500, 500));
        assert!(!window.retry_small());
        window.advance();
        assert_eq!((window.offset, window.size), (1000, 500));
        while window.offset < SCAN_LIMIT {
            assert!(window.size <= BATCH);
            window.advance();
        }
        assert_eq!(window.offset, SCAN_LIMIT);
    }

    #[test]
    fn globs_are_literal_bounded_and_unicode_aware() {
        let mut budget = MATCH_BUDGET;
        assert!(Glob::new("refs/heads/功能/*")
            .unwrap()
            .matches("refs/heads/功能/一", &mut budget)
            .unwrap());
        assert!(Glob::new("refs/heads/?")
            .unwrap()
            .matches("refs/heads/一", &mut budget)
            .unwrap());
        assert!(!Glob::new("refs/heads/feature/*")
            .unwrap()
            .matches("refs/heads/main", &mut budget)
            .unwrap());
        for value in [
            "--all",
            "main*",
            "refs/heads/[ab]",
            "refs/heads/x\\y",
            "refs/heads/a..b",
        ] {
            assert!(Glob::new(value).is_err());
        }
        assert!(Glob::new("refs/*")
            .unwrap()
            .matches("refs/heads/a", &mut 0)
            .is_err());
        assert!(oid_input(&["--all".into()]).is_err());
    }
}
