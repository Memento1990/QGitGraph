//! Parsers for Git's documented NUL-delimited machine formats.
//! No path is split on spaces, tabs, newlines, or Git's quoted display format.

use std::collections::{HashMap, VecDeque};

use crate::error::{AppError, Result};
use crate::model::{ChangedFile, Commit, GitRef, Stash, SubmoduleStatus, WorkingState};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("GIT_PARSE", message)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn path(bytes: &[u8]) -> Result<String> {
    if bytes.is_empty() {
        return Err(invalid("Git returned an empty path"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        invalid("A Git path is not valid UTF-8 and cannot be represented safely by this client")
    })
}

pub(crate) fn is_oid(value: &str) -> bool {
    (4..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn is_full_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn oid(bytes: &[u8]) -> Result<String> {
    let value = std::str::from_utf8(bytes).map_err(|_| invalid("Non-ASCII object ID"))?;
    if value.len() < 40 || !is_oid(value) {
        return Err(invalid(format!(
            "Invalid object ID in Git output: {value:?}"
        )));
    }
    Ok(value.to_owned())
}

fn timestamp(bytes: &[u8]) -> Result<i64> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("Invalid Git timestamp"))
}

fn count(bytes: &[u8]) -> Result<usize> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return Err(invalid("Invalid count in Git output"));
    }
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| invalid("Git count exceeds the supported range"))
}

struct NulReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> NulReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn done(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.offset).copied()
    }

    fn field(&mut self) -> Result<&'a [u8]> {
        let rest = &self.bytes[self.offset..];
        let end = rest
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| invalid("Truncated Git output: missing NUL terminator"))?;
        self.offset += end + 1;
        Ok(&rest[..end])
    }

    fn newline(&mut self) -> Result<()> {
        if self.peek() != Some(b'\n') {
            return Err(invalid("Missing record separator in Git ref output"));
        }
        self.offset += 1;
        Ok(())
    }
}

pub(crate) fn literal_paths(bytes: &[u8]) -> Result<Vec<String>> {
    let mut reader = NulReader::new(bytes);
    let mut paths = Vec::new();
    while !reader.done() {
        paths.push(path(reader.field()?)?);
    }
    Ok(paths)
}

fn commit_fields(reader: &mut NulReader<'_>) -> Result<Commit> {
    let commit_oid = oid(reader.field()?)?;
    let parent_field = reader.field()?;
    let parents = if parent_field.is_empty() {
        Vec::new()
    } else {
        parent_field
            .split(|b| *b == b' ')
            .map(oid)
            .collect::<Result<_>>()?
    };
    let author = text(reader.field()?);
    let email = text(reader.field()?);
    let authored_at = timestamp(reader.field()?)?;
    let committed_at = timestamp(reader.field()?)?;
    let subject = text(reader.field()?);
    Ok(Commit {
        oid: commit_oid,
        parents,
        author,
        email,
        authored_at,
        committed_at,
        subject,
        refs: Vec::new(),
        graph_parents: None,
        node_kind: None,
        in_head: None,
    })
}

/// `git log -z --format=tformat:%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s`.
pub(crate) fn log(bytes: &[u8]) -> Result<Vec<Commit>> {
    let mut reader = NulReader::new(bytes);
    let mut commits = Vec::new();
    while !reader.done() {
        commits.push(commit_fields(&mut reader)?);
    }
    Ok(commits)
}

pub(crate) struct SearchRecord {
    pub commit: Commit,
    pub body: String,
}

/// Log records with an extra `%b` field for whole-message history search.
pub(crate) fn search_log(bytes: &[u8]) -> Result<Vec<SearchRecord>> {
    let mut reader = NulReader::new(bytes);
    let mut records = Vec::new();
    while !reader.done() {
        records.push(SearchRecord {
            commit: commit_fields(&mut reader)?,
            body: text(reader.field()?),
        });
    }
    Ok(records)
}

pub(crate) struct DetailRecord {
    pub commit: Commit,
    pub committer: String,
    pub committer_email: String,
    pub body: String,
}

/// The log format above followed by `%cn%x00%ce%x00%b`.
pub(crate) fn detail(bytes: &[u8]) -> Result<DetailRecord> {
    let mut reader = NulReader::new(bytes);
    let commit = commit_fields(&mut reader)?;
    let committer = text(reader.field()?);
    let committer_email = text(reader.field()?);
    let body = text(reader.field()?);
    if !reader.done() {
        return Err(invalid("Expected exactly one commit detail record"));
    }
    Ok(DetailRecord {
        commit,
        committer,
        committer_email,
        body,
    })
}

/// for-each-ref has an LF after the final explicit NUL of each record.
pub(crate) fn refs(bytes: &[u8]) -> Result<Vec<GitRef>> {
    let mut reader = NulReader::new(bytes);
    let mut result = Vec::new();
    while !reader.done() {
        let full_name = text(reader.field()?);
        let object_oid = oid(reader.field()?)?;
        let peeled_field = reader.field()?;
        let peeled_oid = if peeled_field.is_empty() {
            None
        } else {
            Some(oid(peeled_field)?)
        };
        let object_type = text(reader.field()?);
        let peeled_type = text(reader.field()?);
        let upstream = text(reader.field()?);
        let head = reader.field()?;
        let current = match head {
            b"*" => true,
            b" " | b"" => false,
            _ => return Err(invalid("Invalid HEAD marker in Git ref output")),
        };
        let subject = text(reader.field()?);
        reader.newline()?;
        let (name, kind) = if let Some(name) = full_name.strip_prefix("refs/heads/") {
            (name.to_owned(), "branch")
        } else if let Some(name) = full_name.strip_prefix("refs/remotes/") {
            (name.to_owned(), "remote")
        } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
            (name.to_owned(), "tag")
        } else if full_name == "refs/stash" {
            ("stash".to_owned(), "stash")
        } else {
            continue;
        };
        // A tag may point at a tree/blob rather than a commit. It is not a graph ref.
        let commit_oid = if object_type == "commit" {
            object_oid
        } else if object_type == "tag" && peeled_type == "commit" {
            peeled_oid.ok_or_else(|| invalid("Annotated tag is missing its peeled object ID"))?
        } else {
            continue;
        };
        result.push(GitRef {
            name,
            full_name,
            oid: commit_oid,
            kind: kind.to_owned(),
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream)
            },
            current,
            subject,
        });
    }
    Ok(result)
}

pub(crate) fn stashes(bytes: &[u8]) -> Result<Vec<Stash>> {
    let mut reader = NulReader::new(bytes);
    let mut result = Vec::new();
    while !reader.done() {
        let selector = text(reader.field()?);
        let number = selector
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'));
        if !number.is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) {
            return Err(invalid("Invalid stash selector in Git output"));
        }
        result.push(Stash {
            selector,
            oid: oid(reader.field()?)?,
            message: text(reader.field()?),
            timestamp: timestamp(reader.field()?)?,
        });
    }
    Ok(result)
}

fn status_code(bytes: &[u8]) -> Result<String> {
    if bytes.len() != 2 || !bytes.iter().all(|b| b". MADRCUT?!".contains(b)) {
        return Err(invalid("Invalid porcelain-v2 XY status"));
    }
    Ok(text(bytes))
}

fn check_mode(bytes: &[u8]) -> Result<()> {
    if bytes.len() != 6 || !bytes.iter().all(|b| (b'0'..=b'7').contains(b)) {
        return Err(invalid("Invalid file mode in Git output"));
    }
    Ok(())
}

fn submodule_state(bytes: &[u8]) -> Result<Option<SubmoduleStatus>> {
    if bytes == b"N..." {
        return Ok(None);
    }
    if bytes.len() != 4
        || bytes[0] != b'S'
        || !matches!(bytes[1], b'.' | b'C')
        || !matches!(bytes[2], b'.' | b'M')
        || !matches!(bytes[3], b'.' | b'U')
    {
        return Err(invalid("Invalid porcelain-v2 submodule state"));
    }
    Ok(Some(SubmoduleStatus {
        commit_changed: bytes[1] == b'C',
        modified: bytes[2] == b'M',
        untracked: bytes[3] == b'U',
    }))
}

/// `git status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all`.
pub(crate) fn working_state(bytes: &[u8]) -> Result<WorkingState> {
    let mut reader = NulReader::new(bytes);
    let mut state = WorkingState {
        files: Vec::new(),
        branch: None,
        ahead: 0,
        behind: 0,
        operation: None,
        conflicts: 0,
        head: None,
    };
    while !reader.done() {
        let record = reader.field()?;
        if let Some(value) = record.strip_prefix(b"# branch.oid ") {
            if value != b"(initial)" {
                state.head = Some(oid(value)?);
            }
            continue;
        }
        if let Some(value) = record.strip_prefix(b"# branch.head ") {
            if value != b"(detached)" && value != b"(unknown)" {
                state.branch = Some(text(value));
            }
            continue;
        }
        if let Some(value) = record.strip_prefix(b"# branch.ab ") {
            let mut parts = value.split(|b| *b == b' ');
            let ahead = parts
                .next()
                .and_then(|s| s.strip_prefix(b"+"))
                .ok_or_else(|| invalid("Invalid branch ahead count"))?;
            let behind = parts
                .next()
                .and_then(|s| s.strip_prefix(b"-"))
                .ok_or_else(|| invalid("Invalid branch behind count"))?;
            if parts.next().is_some() {
                return Err(invalid("Invalid branch ahead/behind record"));
            }
            state.ahead = count(ahead)?;
            state.behind = count(behind)?;
            continue;
        }
        if record.starts_with(b"# ") {
            continue; // branch.oid, branch.upstream and future documented headers.
        }
        let tag = *record
            .first()
            .ok_or_else(|| invalid("Empty porcelain-v2 record"))?;
        if tag == b'?' || tag == b'!' {
            let file_path = path(
                record
                    .strip_prefix(&[tag, b' '])
                    .ok_or_else(|| invalid("Malformed untracked/ignored path"))?,
            )?;
            if tag == b'?' {
                state.files.push(ChangedFile {
                    path: file_path,
                    old_path: None,
                    status: "?".into(),
                    additions: None,
                    deletions: None,
                    staged: false,
                    unstaged: true,
                    submodule: None,
                });
            }
            continue;
        }
        let width = match tag {
            b'1' => 9,
            b'2' => 10,
            b'u' => 11,
            _ => return Err(invalid("Unknown porcelain-v2 record type")),
        };
        let fields: Vec<_> = record.splitn(width, |b| *b == b' ').collect();
        if fields.len() != width || fields[0] != [tag] {
            return Err(invalid("Truncated porcelain-v2 record"));
        }
        let status = status_code(fields[1])?;
        let submodule = submodule_state(fields[2])?;
        let (mode_end, oid_end) = if tag == b'u' { (7, 10) } else { (6, 8) };
        for mode in &fields[3..mode_end] {
            check_mode(mode)?;
        }
        for object in &fields[mode_end..oid_end] {
            oid(object)?;
        }
        if tag == b'2' {
            let score = fields[8];
            if score.len() < 2 || !matches!(score[0], b'R' | b'C') || count(&score[1..])? > 100 {
                return Err(invalid("Invalid porcelain-v2 rename/copy score"));
            }
        }
        let file_path = path(fields[width - 1])?;
        let old_path = if tag == b'2' {
            Some(path(reader.field()?)?)
        } else {
            None
        };
        if tag == b'u' {
            state.conflicts += 1;
        }
        state.files.push(ChangedFile {
            path: file_path,
            old_path,
            staged: !matches!(fields[1][0], b'.' | b' '),
            unstaged: !matches!(fields[1][1], b'.' | b' '),
            status,
            additions: None,
            deletions: None,
            submodule,
        });
    }
    Ok(state)
}

/// `git diff --raw --numstat --no-abbrev -z`: raw rows, then numstat rows.
/// Rename/copy paths occur in two separate NUL fields in both sections.
pub(crate) fn diff_files(bytes: &[u8]) -> Result<Vec<ChangedFile>> {
    let mut reader = NulReader::new(bytes);
    let mut files = Vec::new();
    let mut pending: HashMap<(String, Option<String>), VecDeque<usize>> = HashMap::new();
    while reader.peek() == Some(b':') {
        let record = reader.field()?;
        let fields: Vec<_> = record[1..].split(|b| *b == b' ').collect();
        if fields.len() != 5 {
            return Err(invalid(
                "Malformed raw diff record (combined diffs are not supported here)",
            ));
        }
        check_mode(fields[0])?;
        check_mode(fields[1])?;
        oid(fields[2])?;
        oid(fields[3])?;
        let status = fields[4];
        if status.is_empty() || !b"ACDMRTUXB".contains(&status[0]) {
            return Err(invalid("Invalid raw diff status"));
        }
        if status.len() > 1 && count(&status[1..])? > 100 {
            return Err(invalid("Invalid raw diff similarity score"));
        }
        let first = path(reader.field()?)?;
        let (file_path, old_path) = if matches!(status[0], b'R' | b'C') {
            if status.len() == 1 {
                return Err(invalid("Rename/copy has no similarity score"));
            }
            (path(reader.field()?)?, Some(first))
        } else {
            (first, None)
        };
        pending
            .entry((file_path.clone(), old_path.clone()))
            .or_default()
            .push_back(files.len());
        files.push(ChangedFile {
            path: file_path,
            old_path,
            status: text(status),
            additions: None,
            deletions: None,
            staged: false,
            unstaged: false,
            submodule: if fields[0] == b"160000" || fields[1] == b"160000" {
                Some(SubmoduleStatus {
                    commit_changed: fields[2] != fields[3],
                    modified: false,
                    untracked: false,
                })
            } else {
                None
            },
        });
    }
    let mut stats = 0;
    while !reader.done() {
        let record = reader.field()?;
        let fields: Vec<_> = record.splitn(3, |b| *b == b'\t').collect();
        if fields.len() != 3 {
            return Err(invalid("Malformed numstat record"));
        }
        let (additions, deletions) = if fields[0] == b"-" && fields[1] == b"-" {
            (None, None)
        } else {
            (Some(count(fields[0])?), Some(count(fields[1])?))
        };
        let (file_path, old_path) = if fields[2].is_empty() {
            let old = path(reader.field()?)?;
            (path(reader.field()?)?, Some(old))
        } else {
            (path(fields[2])?, None)
        };
        let index = pending
            .get_mut(&(file_path, old_path))
            .and_then(VecDeque::pop_front)
            .ok_or_else(|| invalid("A numstat path has no matching raw diff entry"))?;
        files[index].additions = additions;
        files[index].deletions = deletions;
        stats += 1;
    }
    if stats != files.len() {
        return Err(invalid("Git diff output is missing numstat records"));
    }
    Ok(files)
}

/// `git diff --numstat -z --patch`: NUL-framed stats, one empty NUL
/// separator, then the patch. Stats retain binary truth for a pure rename,
/// whose patch has neither a Binary-files marker nor a GIT-binary-patch body.
/// Never search for separators in paths or split paths on tabs/newlines.
pub(crate) fn patch_with_numstat(bytes: &[u8]) -> Result<(&[u8], bool)> {
    if bytes.is_empty() {
        return Ok((bytes, false));
    }
    let mut reader = NulReader::new(bytes);
    let mut binary = false;
    loop {
        let record = reader.field()?;
        if record.is_empty() {
            return Ok((&bytes[reader.offset..], binary));
        }
        let fields: Vec<_> = record.splitn(3, |b| *b == b'\t').collect();
        if fields.len() != 3 {
            return Err(invalid("Malformed patch numstat record"));
        }
        if fields[0] == b"-" && fields[1] == b"-" {
            binary = true;
        } else {
            count(fields[0])?;
            count(fields[1])?;
        }
        if fields[2].is_empty() {
            path(reader.field()?)?;
            path(reader.field()?)?;
        } else {
            path(fields[2])?;
        }
        if reader.done() {
            return Err(invalid("Patch output is missing its NUL separator"));
        }
    }
}

#[derive(Debug)]
pub(crate) struct TreeEntry {
    pub mode: String,
    pub kind: String,
    pub oid: String,
    pub path: String,
    /// `ls-tree -l` returns a decimal size for blobs and `-` otherwise.
    pub size: Option<usize>,
}

pub(crate) fn tree_entries(bytes: &[u8]) -> Result<Vec<TreeEntry>> {
    let mut reader = NulReader::new(bytes);
    let mut result = Vec::new();
    while !reader.done() {
        let field = reader.field()?;
        let tab = field
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| invalid("Malformed ls-tree record"))?;
        let meta: Vec<_> = field[..tab]
            .split(|b| *b == b' ')
            .filter(|part| !part.is_empty())
            .collect();
        if !matches!(meta.len(), 3 | 4) {
            return Err(invalid("Malformed ls-tree metadata"));
        }
        check_mode(meta[0])?;
        let kind = text(meta[1]);
        if !matches!(kind.as_str(), "blob" | "tree" | "commit") {
            return Err(invalid("Unknown ls-tree object type"));
        }
        let size = if meta.len() == 4 {
            match (kind.as_str(), meta[3]) {
                ("blob", size) => Some(count(size)?),
                (_, b"-") => None,
                _ => return Err(invalid("Unexpected ls-tree size for a non-blob")),
            }
        } else {
            None
        };
        result.push(TreeEntry {
            mode: text(meta[0]),
            kind,
            oid: oid(meta[2])?,
            path: path(&field[tab + 1..])?,
            size,
        });
    }
    Ok(result)
}

#[derive(Debug)]
pub(crate) struct IndexEntry {
    pub mode: String,
    pub oid: String,
    pub stage: u8,
    pub path: String,
}

pub(crate) fn index_entries(bytes: &[u8]) -> Result<Vec<IndexEntry>> {
    let mut reader = NulReader::new(bytes);
    let mut result = Vec::new();
    while !reader.done() {
        let field = reader.field()?;
        let tab = field
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| invalid("Malformed ls-files stage record"))?;
        let meta: Vec<_> = field[..tab].split(|b| *b == b' ').collect();
        if meta.len() != 3 {
            return Err(invalid("Malformed ls-files stage metadata"));
        }
        check_mode(meta[0])?;
        let stage = match meta[2] {
            b"0" => 0,
            b"1" => 1,
            b"2" => 2,
            b"3" => 3,
            _ => return Err(invalid("Invalid index stage")),
        };
        result.push(IndexEntry {
            mode: text(meta[0]),
            oid: oid(meta[1])?,
            stage,
            path: path(&field[tab + 1..])?,
        });
    }
    Ok(result)
}

#[derive(Debug)]
pub(crate) struct ConfigEntry {
    pub scope: String,
    pub key: String,
    pub value: Option<String>,
}

/// `git config --null --list --show-scope --includes`.
pub(crate) fn config(bytes: &[u8]) -> Result<Vec<ConfigEntry>> {
    let mut reader = NulReader::new(bytes);
    let mut result = Vec::new();
    while !reader.done() {
        let scope = text(reader.field()?);
        if !matches!(
            scope.as_str(),
            "system" | "global" | "local" | "worktree" | "command"
        ) {
            return Err(invalid("Unknown Git configuration scope"));
        }
        let field = reader.field()?;
        let (key, value) = match field.iter().position(|b| *b == b'\n') {
            Some(pos) => (&field[..pos], Some(text(&field[pos + 1..]))),
            None => (field, None),
        };
        let key = std::str::from_utf8(key)
            .map_err(|_| invalid("Git configuration key is not valid UTF-8"))?;
        let (section, remainder) = key
            .split_once('.')
            .ok_or_else(|| invalid("Invalid Git configuration key"))?;
        let variable = remainder.rsplit('.').next().unwrap_or("");
        // Section/variable names are ASCII; a quoted subsection is not. In
        // particular remote/submodule/branch names may contain Unicode and dots.
        if section.is_empty()
            || !section
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || variable.is_empty()
            || !variable.as_bytes()[0].is_ascii_alphabetic()
            || !variable
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || key.chars().any(char::is_control)
        {
            return Err(invalid("Invalid Git configuration key"));
        }
        result.push(ConfigEntry {
            scope,
            key: key.to_owned(),
            value,
        });
    }
    Ok(result)
}

pub(crate) struct TagObject {
    pub tagger: String,
    pub email: String,
    pub timestamp: Option<i64>,
    pub message: String,
    pub signed: bool,
}

fn raw_parts(bytes: &[u8]) -> Result<(&[u8], &[u8])> {
    let end = bytes
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .ok_or_else(|| invalid("Git object has no header/message separator"))?;
    Ok((&bytes[..end], &bytes[end + 2..]))
}

fn identity(bytes: &[u8]) -> Result<(String, String, i64)> {
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b'>')
        .ok_or_else(|| invalid("Invalid object identity email"))?;
    let start = bytes[..end]
        .iter()
        .rposition(|byte| *byte == b'<')
        .ok_or_else(|| invalid("Invalid object identity email"))?;
    let name = text(&bytes[..start]).trim_end().to_owned();
    let email = text(&bytes[start + 1..end]);
    let tail = bytes[end + 1..]
        .strip_prefix(b" ")
        .ok_or_else(|| invalid("Invalid object identity timestamp"))?;
    let mut fields = tail.split(|byte| *byte == b' ');
    let time = timestamp(
        fields
            .next()
            .ok_or_else(|| invalid("Missing identity timestamp"))?,
    )?;
    let timezone = fields
        .next()
        .ok_or_else(|| invalid("Missing identity timezone"))?;
    if fields.next().is_some()
        || timezone.len() != 5
        || !matches!(timezone[0], b'+' | b'-')
        || !timezone[1..].iter().all(u8::is_ascii_digit)
    {
        return Err(invalid("Invalid object identity timezone"));
    }
    Ok((name, email, time))
}

/// Raw annotated tag metadata, without `%G?` or signature verification. Git
/// signatures are trailing armor blocks. The public message excludes that block.
pub(crate) fn tag_object(bytes: &[u8]) -> Result<TagObject> {
    let (headers, body) = raw_parts(bytes)?;
    let mut tagger = String::new();
    let mut email = String::new();
    let mut time = None;
    let mut object = false;
    let mut kind = false;
    for line in headers.split(|byte| *byte == b'\n') {
        if let Some(value) = line.strip_prefix(b"object ") {
            oid(value)?;
            object = true;
        }
        if let Some(value) = line.strip_prefix(b"type ") {
            if !matches!(value, b"commit" | b"tree" | b"blob" | b"tag") {
                return Err(invalid("Invalid tag target type"));
            }
            kind = true;
        }
        if let Some(value) = line.strip_prefix(b"tagger ") {
            if time.is_some() {
                return Err(invalid("Duplicate tagger identity"));
            }
            let value = identity(value)?;
            tagger = value.0;
            email = value.1;
            time = Some(value.2);
        }
    }
    if !object || !kind {
        return Err(invalid("Annotated tag lacks object/type headers"));
    }
    let signatures: [(&[u8], &[u8]); 3] = [
        (
            b"-----BEGIN PGP SIGNATURE-----",
            b"-----END PGP SIGNATURE-----",
        ),
        (
            b"-----BEGIN SSH SIGNATURE-----",
            b"-----END SSH SIGNATURE-----",
        ),
        (
            b"-----BEGIN SIGNED MESSAGE-----",
            b"-----END SIGNED MESSAGE-----",
        ),
    ];
    let mut signature_start = None;
    let mut offset = 0;
    for line in body.split_inclusive(|byte| *byte == b'\n') {
        let plain = line.strip_suffix(b"\n").unwrap_or(line);
        let plain = plain.strip_suffix(b"\r").unwrap_or(plain);
        for (begin, end) in signatures {
            if plain == begin && body[offset..].windows(end.len()).any(|part| part == end) {
                signature_start = Some(offset);
                break;
            }
        }
        if signature_start.is_some() {
            break;
        }
        offset += line.len();
    }
    Ok(TagObject {
        tagger,
        email,
        timestamp: time,
        message: text(&body[..signature_start.unwrap_or(body.len())]),
        signed: signature_start.is_some(),
    })
}

pub(crate) struct StashCommit {
    pub parents: Vec<String>,
    pub timestamp: i64,
    pub message: String,
}

pub(crate) fn stash_commit(bytes: &[u8]) -> Result<StashCommit> {
    let (headers, body) = raw_parts(bytes)?;
    let mut parents = Vec::new();
    let mut time = None;
    for line in headers.split(|byte| *byte == b'\n') {
        if let Some(value) = line.strip_prefix(b"parent ") {
            parents.push(oid(value)?);
        }
        if let Some(value) = line.strip_prefix(b"committer ") {
            time = Some(identity(value)?.2);
        }
    }
    Ok(StashCommit {
        parents,
        timestamp: time.ok_or_else(|| invalid("Stash has no committer timestamp"))?,
        message: text(body),
    })
}

/// Detect signatures without `%G?`, which would launch a configured GPG program.
pub(crate) fn has_commit_signature(bytes: &[u8]) -> Result<bool> {
    let end = bytes
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .ok_or_else(|| invalid("Commit object has no header/message separator"))?;
    Ok(bytes[..end]
        .split(|b| *b == b'\n')
        .any(|line| line.starts_with(b"gpgsig ") || line.starts_with(b"gpgsig-sha256 ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(c: char) -> String {
        c.to_string().repeat(40)
    }
    fn zeros() -> String {
        "0".repeat(40)
    }

    #[test]
    fn log_handles_root_merge_unicode_and_sha256() {
        let a = hash('a');
        let b = hash('b');
        let c = "c".repeat(64);
        let bytes = format!("{a}\0\0作者 张\0a@example.com\01700000000\01700000001\0根 提交\0{c}\0{a} {b}\0Merge Author\0m@example.com\01700000002\01700000003\0合并 中文\0");
        let commits = log(bytes.as_bytes()).unwrap();
        assert_eq!(commits.len(), 2);
        assert!(commits[0].parents.is_empty());
        assert_eq!(commits[0].author, "作者 张");
        assert_eq!(commits[1].oid.len(), 64);
        assert_eq!(commits[1].parents, vec![a, b]);
        assert!(log(&bytes.as_bytes()[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn detail_keeps_multiline_body() {
        let bytes = format!(
            "{}\0\0作者\0a@b\01\02\0Subject\0提交者\0c@d\0正文\n\nmore\n\0",
            hash('a')
        );
        let value = detail(bytes.as_bytes()).unwrap();
        assert_eq!(value.committer, "提交者");
        assert_eq!(value.body, "正文\n\nmore\n");
        assert!(detail(&[bytes.as_bytes(), b"extra\0"].concat()).is_err());
    }

    #[test]
    fn refs_peel_annotated_tags_and_retain_upstream() {
        let a = hash('a');
        let b = hash('b');
        let bytes = format!("refs/heads/功能\0{a}\0\0commit\0\0refs/remotes/origin/功能\0*\0中文 标题\0\nrefs/tags/v1\0{b}\0{a}\0tag\0commit\0\0 \0Release\0\n");
        let values = refs(bytes.as_bytes()).unwrap();
        assert_eq!(values[0].name, "功能");
        assert!(values[0].current);
        assert_eq!(
            values[0].upstream.as_deref(),
            Some("refs/remotes/origin/功能")
        );
        assert_eq!(values[1].oid, a);
        assert_eq!(values[1].kind, "tag");
        assert!(refs(bytes.trim_end_matches('\n').as_bytes()).is_err());
    }

    #[test]
    fn status_handles_rename_spaces_tabs_and_conflicts() {
        let a = hash('a');
        let z = zeros();
        let bytes = format!("# branch.oid {a}\0# branch.head 功能\0# branch.ab +12 -3\02 RM N... 100644 100644 100644 {a} {a} R100 新 文件\t名.txt\0旧 文件.txt\0u UU N... 100644 100644 100644 100644 {a} {a} {a} 冲突.txt\0? 未跟踪\n文件.txt\01 .M N... 100644 100644 100644 {a} {z} 修改.txt\0");
        let value = working_state(bytes.as_bytes()).unwrap();
        assert_eq!(value.branch.as_deref(), Some("功能"));
        assert_eq!((value.ahead, value.behind, value.conflicts), (12, 3, 1));
        assert_eq!(value.files[0].path, "新 文件\t名.txt");
        assert_eq!(value.files[0].old_path.as_deref(), Some("旧 文件.txt"));
        assert!(value.files[0].staged && value.files[0].unstaged);
        assert_eq!(value.files[2].path, "未跟踪\n文件.txt");
        assert!(!value.files[3].staged && value.files[3].unstaged);
        assert!(working_state(b"2 R. N... truncated\0").is_err());
        assert!(working_state(b"? \xff\0").is_err());
    }

    #[test]
    fn diff_handles_rename_binary_and_newline_paths() {
        let a = hash('a');
        let b = hash('b');
        let bytes = format!(":100644 100644 {a} {b} R087\0旧 文件\0新\t文件\0:100644 100644 {a} {b} M\0二进制\nfile\02\t1\t\0旧 文件\0新\t文件\0-\t-\t二进制\nfile\0");
        let value = diff_files(bytes.as_bytes()).unwrap();
        assert_eq!(value[0].old_path.as_deref(), Some("旧 文件"));
        assert_eq!(value[0].path, "新\t文件");
        assert_eq!((value[0].additions, value[0].deletions), (Some(2), Some(1)));
        assert_eq!(value[1].additions, None);
        assert_eq!(value[1].path, "二进制\nfile");
        let missing_stat = format!(":100644 100644 {a} {b} M\0file\0");
        assert!(diff_files(missing_stat.as_bytes()).is_err());
        assert!(diff_files(b"1\t1\tmissing\0").is_err());
    }

    #[test]
    fn stashes_are_structured_and_strict() {
        let bytes = format!(
            "stash@{{0}}\0{}\0On main: 中文 stash\01700000000\0",
            hash('a')
        );
        let values = stashes(bytes.as_bytes()).unwrap();
        assert_eq!(values[0].selector, "stash@{0}");
        assert_eq!(values[0].message, "On main: 中文 stash");
        assert!(stashes(bytes.replace("stash@{0}", "stash@{x}").as_bytes()).is_err());
    }

    #[test]
    fn tree_and_index_preserve_literal_paths() {
        let a = hash('a');
        let tree = tree_entries(format!("100644 blob {a}\t中文 \t file\0").as_bytes()).unwrap();
        assert_eq!(tree[0].path, "中文 \t file");
        let index = index_entries(format!("100644 {a} 2\t中文 file\0").as_bytes()).unwrap();
        assert_eq!(index[0].stage, 2);
        assert!(index_entries(format!("100644 {a} 9\tfile\0").as_bytes()).is_err());
    }

    #[test]
    fn patch_numstat_preserves_nul_paths_and_binary_rename_truth() {
        let bytes =
            b"1\t1\ttext\tline\nfile\0-\t-\t\0old\tname\0new\nname\0\0diff --git a/file b/file\n";
        let (patch, binary) = patch_with_numstat(bytes).unwrap();
        assert!(binary);
        assert_eq!(patch, b"diff --git a/file b/file\n");
        assert_eq!(patch_with_numstat(b"").unwrap(), (&b""[..], false));
        assert!(!patch_with_numstat(b"1\t0\ttext\0\0patch").unwrap().1);
        for malformed in [
            &b"1\t0\ttext\0"[..],
            &b"1\t0\ttext"[..],
            &b"-\t1\tfile\0\0patch"[..],
            &b"1\t0\t\0old\0\0patch"[..],
            &b"1\t0\t\0old\0new"[..],
        ] {
            assert!(patch_with_numstat(malformed).is_err(), "{malformed:?}");
        }
    }

    #[test]
    fn tree_sizes_are_optional_only_without_long_format_or_for_non_blobs() {
        let a = hash('a');
        let bytes = format!(
            "100644 blob {a}       4\tfile\tname\0\
                             160000 commit {a}       -\tmodule\0\
                             040000 tree {a}       -\tdir\0"
        );
        let entries = tree_entries(bytes.as_bytes()).unwrap();
        assert_eq!(entries[0].size, Some(4));
        assert_eq!(entries[0].path, "file\tname");
        assert_eq!(entries[1].size, None);
        assert_eq!(entries[2].size, None);
        for meta in ["100644 blob", "160000 commit", "040000 tree"] {
            assert!(tree_entries(format!("{meta} {a}       invalid\tpath\0").as_bytes()).is_err());
        }
        assert!(tree_entries(format!("100644 blob {a}       -\tpath\0").as_bytes()).is_err());
        assert!(tree_entries(format!("160000 commit {a}       4\tpath\0").as_bytes()).is_err());
    }

    #[test]
    fn config_keeps_empty_multiline_and_scope_values() {
        let values = config(b"global\0user.name\nGlobal Name\0local\0user.name\n\0local\0some.flag\0local\0some.text\nline 1\nline 2\0").unwrap();
        assert_eq!(values[0].scope, "global");
        assert_eq!(values[1].value.as_deref(), Some(""));
        assert_eq!(values[2].value, None);
        assert_eq!(values[3].value.as_deref(), Some("line 1\nline 2"));
        assert!(config(b"local\0truncated").is_err());
    }

    #[test]
    fn signature_detection_does_not_consider_message_text() {
        assert!(!has_commit_signature(b"tree abcd\nauthor A\n\ngpgsig message\n").unwrap());
        assert!(
            has_commit_signature(b"tree abcd\ngpgsig -----BEGIN\n continuation\n\nbody").unwrap()
        );
        assert!(has_commit_signature(b"tree abcd\ngpgsig-sha256 -----BEGIN\n\n").unwrap());
        assert!(has_commit_signature(b"missing separator").is_err());
    }
}
