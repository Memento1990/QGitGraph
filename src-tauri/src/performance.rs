//! Opt-in, in-memory diagnostics only. Never records Git arguments, output, paths, or repository data.
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsStr,
    sync::{Mutex, OnceLock},
    time::Instant,
};

pub const CAPACITY: usize = 2000;
static RECORDER: OnceLock<Recorder> = OnceLock::new();

pub fn requested<'a>(
    arguments: impl IntoIterator<Item = &'a OsStr>,
    environment: Option<&OsStr>,
) -> bool {
    environment == Some(OsStr::new("1"))
        || arguments
            .into_iter()
            .any(|argument| argument == "--performance")
}
pub fn initialize(enabled: bool) {
    let _ = RECORDER.set(Recorder::new(enabled));
}
pub fn enabled() -> bool {
    RECORDER.get().is_some_and(|recorder| recorder.enabled)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanData {
    pub id: u64,
    pub sequence: u64,
    pub request_id: String,
    pub phase: &'static str,
    pub verb: &'static str,
    pub started_at: f64,
    pub duration_ms: f64,
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<i32>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSpan {
    pub id: u64,
    pub request_id: String,
    pub phase: &'static str,
    pub verb: &'static str,
    pub started_at: f64,
    pub elapsed_ms: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceData {
    pub schema_version: u32,
    pub enabled: bool,
    pub capacity: usize,
    pub sequence: u64,
    pub dropped: u64,
    pub spans: Vec<SpanData>,
    pub active: Vec<ActiveSpan>,
}
struct Ring {
    next_id: u64,
    sequence: u64,
    dropped: u64,
    spans: VecDeque<SpanData>,
    active: HashMap<u64, (SpanData, Instant)>,
}
struct Recorder {
    enabled: bool,
    origin: Instant,
    ring: Mutex<Ring>,
}
impl Recorder {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            origin: Instant::now(),
            ring: Mutex::new(Ring {
                next_id: 0,
                sequence: 0,
                dropped: 0,
                spans: VecDeque::new(),
                active: HashMap::new(),
            }),
        }
    }
    fn begin(
        &self,
        request_id: &str,
        phase: &'static str,
        verb: &'static str,
    ) -> Option<(SpanData, Instant)> {
        if !self.enabled {
            return None;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|error| error.into_inner());
        if ring.active.len() >= CAPACITY {
            ring.dropped += 1;
            return None;
        }
        ring.next_id += 1;
        let started = Instant::now();
        let safe_request = request_id.len() <= 128
            && request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte));
        let data = SpanData {
            id: ring.next_id,
            sequence: 0,
            request_id: if safe_request {
                request_id.to_owned()
            } else {
                String::new()
            },
            phase,
            verb,
            started_at: started.duration_since(self.origin).as_secs_f64() * 1000.0,
            duration_ms: 0.0,
            outcome: "error",
            stdout_bytes: None,
            stderr_bytes: None,
            status: None,
        };
        ring.active.insert(data.id, (data.clone(), started));
        Some((data, started))
    }
    fn end(&self, mut data: SpanData, started: Instant) {
        let mut ring = self.ring.lock().unwrap_or_else(|error| error.into_inner());
        if ring.active.remove(&data.id).is_none() {
            return;
        }
        ring.sequence += 1;
        data.sequence = ring.sequence;
        data.duration_ms = started.elapsed().as_secs_f64() * 1000.0;
        if ring.spans.len() == CAPACITY {
            ring.spans.pop_front();
            ring.dropped += 1;
        }
        ring.spans.push_back(data);
    }
    fn read(&self, clear: bool) -> PerformanceData {
        let mut ring = self.ring.lock().unwrap_or_else(|error| error.into_inner());
        let data = PerformanceData {
            schema_version: 1,
            enabled: self.enabled,
            capacity: CAPACITY,
            sequence: ring.sequence,
            dropped: ring.dropped,
            spans: ring.spans.iter().cloned().collect(),
            active: ring
                .active
                .values()
                .map(|(data, started)| ActiveSpan {
                    id: data.id,
                    request_id: data.request_id.clone(),
                    phase: data.phase,
                    verb: data.verb,
                    started_at: data.started_at,
                    elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                })
                .collect(),
        };
        if clear {
            ring.spans.clear();
            ring.dropped = 0;
        }
        data
    }
}

pub fn read(clear: bool) -> Option<PerformanceData> {
    RECORDER
        .get()
        .filter(|recorder| recorder.enabled)
        .map(|recorder| recorder.read(clear))
}

/// A disabled span performs no allocation, clock read, or lock. Drop closes every early-return/cancel/error path.
pub struct Span {
    entry: Option<(SpanData, Instant)>,
}
impl Span {
    pub fn begin(request_id: &str, phase: &'static str, verb: &'static str) -> Self {
        Self {
            entry: RECORDER
                .get()
                .and_then(|recorder| recorder.begin(request_id, phase, verb)),
        }
    }
    pub fn complete(&mut self) {
        self.outcome("ok");
    }
    pub fn outcome(&mut self, outcome: &'static str) {
        if let Some((data, _)) = &mut self.entry {
            data.outcome = outcome;
        }
    }
    pub fn output(&mut self, stdout: Option<usize>, stderr: Option<usize>, status: Option<i32>) {
        if let Some((data, _)) = &mut self.entry {
            data.stdout_bytes = stdout;
            data.stderr_bytes = stderr;
            data.status = status;
        }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if let (Some(recorder), Some((data, started))) = (RECORDER.get(), self.entry.take()) {
            recorder.end(data, started);
        }
    }
}

/// An allowlist maps only a semantic verb; even unexpected arguments can never be copied into telemetry.
pub fn git_verb(arguments: &[String]) -> &'static str {
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].as_str();
        if argument == "-c" {
            index += 2;
            continue;
        }
        return match argument {
            "--version" => "version",
            "log" => "log",
            "status" => "status",
            "rev-parse" => "rev-parse",
            "rev-list" => "rev-list",
            "show" => "show",
            "show-ref" => "show-ref",
            "for-each-ref" => "for-each-ref",
            "symbolic-ref" => "symbolic-ref",
            "diff" => "diff",
            "diff-tree" => "diff-tree",
            "cat-file" => "cat-file",
            "ls-tree" => "ls-tree",
            "ls-files" => "ls-files",
            "config" => "config",
            "remote" => "remote",
            "stash" => "stash",
            "tag" => "tag",
            "branch" => "branch",
            "reflog" => "reflog",
            "merge-base" => "merge-base",
            "submodule" => "submodule",
            "verify-commit" => "verify-commit",
            "verify-tag" => "verify-tag",
            "fetch" => "fetch",
            "pull" => "pull",
            "push" => "push",
            "checkout" => "checkout",
            "switch" => "switch",
            "merge" => "merge",
            "rebase" => "rebase",
            "cherry-pick" => "cherry-pick",
            "revert" => "revert",
            "reset" => "reset",
            "clean" => "clean",
            "commit" => "commit",
            "update-ref" => "update-ref",
            "archive" => "archive",
            "add" => "add",
            _ => "other",
        };
    }
    "other"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enablement_is_explicit_and_exact() {
        assert!(!requested([OsStr::new("app")], None));
        assert!(!requested(
            [OsStr::new("--performance=false")],
            Some(OsStr::new("true"))
        ));
        assert!(requested([OsStr::new("--performance")], None));
        assert!(requested([OsStr::new("app")], Some(OsStr::new("1"))));
    }
    #[test]
    fn ring_is_bounded_and_clear_preserves_active_ids_and_sequence() {
        let recorder = Recorder::new(true);
        let (pending, pending_at) = recorder.begin("ui-pending", "queue", "log").unwrap();
        for _ in 0..CAPACITY + 5 {
            let (span, at) = recorder.begin("ui-1", "execution", "log").unwrap();
            recorder.end(span, at);
        }
        let snapshot = recorder.read(true);
        assert_eq!(snapshot.spans.len(), CAPACITY);
        assert_eq!(snapshot.dropped, 5);
        assert_eq!(snapshot.active.len(), 1);
        let sequence = snapshot.sequence;
        assert!(recorder.read(false).spans.is_empty());
        recorder.end(pending, pending_at);
        let final_data = recorder.read(false);
        assert!(final_data.active.is_empty());
        assert_eq!(final_data.sequence, sequence + 1);
    }
    #[test]
    fn disabled_and_private_data_are_not_recorded() {
        assert!(Recorder::new(false).begin("ui-1", "queue", "log").is_none());
        let recorder = Recorder::new(true);
        let (span, at) = recorder
            .begin(
                "C:/private/repo",
                "execution",
                git_verb(&[
                    "-c".into(),
                    "secret=value".into(),
                    "log".into(),
                    "private subject".into(),
                ]),
            )
            .unwrap();
        recorder.end(span, at);
        let data = recorder.read(false);
        assert_eq!(data.spans[0].verb, "log");
        assert_eq!(data.spans[0].request_id, "");
        let encoded = serde_json::to_string(&data).unwrap();
        assert!(!encoded.contains("private"));
        assert!(!encoded.contains("secret"));
        assert_eq!(git_verb(&["https://private.example/repo".into()]), "other");
    }
}
