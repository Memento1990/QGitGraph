//! Explicit, local-only native usage recording. No HTTP, Tauri, repository IO or arbitrary-path IPC.
//! The caller supplies the backend-selected profile and compile-time source build, never frontend paths.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::hash_map::RandomState;
use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const SESSION_BYTES: u64 = 10 * 1024 * 1024;
const GLOBAL_BYTES: u64 = 50 * 1024 * 1024;
const SESSION_COUNT: usize = 1000;
const SCHEMA: u32 = 1;
const ERROR_CODES: &[&str] = &[
    "CANCELLED",
    "USER_CANCELLED",
    "GIT_FAILED",
    "IO",
    "ACCESS_DENIED",
    "NOT_TRUSTED",
    "TRUST_REQUIRED",
    "TRUST_REVOKED",
    "STALE_TARGET",
    "INVALID_INPUT",
    "NOT_FOUND",
    "CONFLICT",
    "TIMEOUT",
    "UNAVAILABLE",
    "DESKTOP_REQUIRED",
    "USAGE_FULL",
    "USAGE_WRITE_FAILED",
    "UNKNOWN_ERROR",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageError {
    pub code: &'static str,
    pub message: &'static str,
}
impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for UsageError {}
fn error(code: &'static str, message: &'static str) -> UsageError {
    UsageError { code, message }
}
fn io_error(_: std::io::Error) -> UsageError {
    error(
        "USAGE_WRITE_FAILED",
        "Local usage storage failed; recording is not confirmed.",
    )
}
fn invalid() -> UsageError {
    error(
        "INVALID_USAGE_INPUT",
        "Usage accepts only bounded anonymous identifiers, counts and state.",
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageRuntime {
    pub app_version: String,
    pub source_build: String,
    pub source_build_reliable: bool,
    pub exe_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageSource {
    Userusage,
    Assistant,
    AutomatedTest,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageStart {
    pub source: UsageSource,
    #[serde(default)]
    pub task_ids: Vec<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageBoundary {
    Pause,
    Resume,
    Stop,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageEventInput {
    pub task_ids: Vec<String>,
    pub scenario_id: String,
    pub action_id: String,
    pub result_code: String,
    pub occurred_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub repo_id: Option<String>,
    pub counts: Option<Map<String, Value>>,
    pub state: Option<Map<String, Value>>,
    pub error_code: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub session_bytes: u64,
    pub global_bytes: u64,
    pub session_count: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    pub phase: String,
    pub session_id: Option<String>,
    pub source: Option<UsageSource>,
    pub build: String,
    pub runtime: UsageRuntime,
    pub event_count: u64,
    pub bytes: u64,
    pub total_bytes: u64,
    pub session_count: usize,
    pub limits: UsageLimits,
    pub error_code: Option<String>,
}
struct Session {
    file: File,
    id: String,
    source: UsageSource,
    tasks: Vec<String>,
    sequence: u64,
    events: u64,
    bytes: u64,
    last_occurred: String,
    last_collected: String,
}
pub struct UsageRecorder {
    directory: PathBuf,
    build: String,
    runtime: UsageRuntime,
    phase: &'static str,
    session: Option<Session>,
    total_bytes: u64,
    session_count: usize,
    error_code: Option<&'static str>,
    limits: UsageLimits,
}
impl UsageRecorder {
    /// source_build should be option_env!("QG_SOURCE_BUILD").unwrap_or("development").
    /// The executable digest is measured at runtime: never embed an executable's own hash into it.
    pub fn new(
        profile: PathBuf,
        source_build: &str,
        app_version: &str,
    ) -> Result<Self, UsageError> {
        let exe = std::env::current_exe().map_err(io_error)?;
        let mut file = File::open(exe).map_err(io_error)?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let length = file.read(&mut buffer).map_err(io_error)?;
            if length == 0 {
                break;
            }
            digest.update(&buffer[..length]);
        }
        Self::with_runtime(
            profile,
            UsageRuntime {
                app_version: app_version.into(),
                source_build: source_build.into(),
                source_build_reliable: !matches!(
                    source_build,
                    "development" | "unknown" | "unavailable"
                ),
                exe_sha256: digest.finish(),
            },
        )
    }
    fn with_runtime(profile: PathBuf, runtime: UsageRuntime) -> Result<Self, UsageError> {
        if !identifier(&runtime.app_version)
            || !identifier(&runtime.source_build)
            || runtime.exe_sha256.len() != 64
            || !runtime
                .exe_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        // Creating an idle recorder does not create any log or start a session.
        let mut recorder = Self {
            directory: profile.join("usage"),
            build: format!("native-{}", runtime.exe_sha256),
            runtime,
            phase: "idle",
            session: None,
            total_bytes: 0,
            session_count: 0,
            error_code: None,
            limits: UsageLimits {
                session_bytes: SESSION_BYTES,
                global_bytes: GLOBAL_BYTES,
                session_count: SESSION_COUNT,
            },
        };
        recorder.scan()?;
        Ok(recorder)
    }
    pub fn status(&self) -> UsageStatus {
        UsageStatus {
            phase: self.phase.into(),
            session_id: self.session.as_ref().map(|s| s.id.clone()),
            source: self.session.as_ref().map(|s| s.source.clone()),
            build: self.build.clone(),
            runtime: self.runtime.clone(),
            event_count: self.session.as_ref().map_or(0, |s| s.events),
            bytes: self.session.as_ref().map_or(0, |s| s.bytes),
            total_bytes: self.total_bytes,
            session_count: self.session_count,
            limits: self.limits.clone(),
            error_code: self.error_code.map(str::to_string),
        }
    }
    pub fn start(&mut self, input: UsageStart) -> Result<UsageStatus, UsageError> {
        if matches!(self.phase, "recording" | "paused") {
            return Err(error(
                "USAGE_SESSION_ACTIVE",
                "Stop the current session before choosing another source.",
            ));
        }
        validate_tasks(&input.task_ids)?;
        let result = self.start_inner(input);
        if let Err(ref failure) = result {
            self.storage_failure(failure);
        }
        result.map(|_| self.status())
    }
    fn start_inner(&mut self, input: UsageStart) -> Result<(), UsageError> {
        self.scan()?;
        if self.session_count >= self.limits.session_count {
            return Err(error(
                "USAGE_FULL",
                "Usage session limit reached; no logs were deleted.",
            ));
        }
        fs::create_dir_all(&self.directory).map_err(io_error)?;
        reject_link(&self.directory)?;
        let id = session_id();
        let now = now_iso()?;
        let header = json!({"kind":"native-session","schemaVersion":SCHEMA,"sessionId":id,"source":input.source,"build":self.build,"runtime":self.runtime,"taskIds":input.task_ids,"createdAt":now});
        let start = boundary_record(
            &id,
            &input.source,
            &self.build,
            &input.task_ids,
            1,
            "start",
            &now,
        );
        let bytes = encode(&[header, start])?;
        self.check_capacity(0, bytes.len() as u64)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.directory.join(format!("{id}.jsonl")))
            .map_err(io_error)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(io_error)?;
        self.total_bytes += bytes.len() as u64;
        self.session_count += 1;
        self.session = Some(Session {
            file,
            id,
            source: input.source,
            tasks: input.task_ids,
            sequence: 1,
            events: 0,
            bytes: bytes.len() as u64,
            last_occurred: now.clone(),
            last_collected: now,
        });
        self.phase = "recording";
        self.error_code = None;
        Ok(())
    }
    pub fn boundary(&mut self, boundary: UsageBoundary) -> Result<UsageStatus, UsageError> {
        let (name, next) = match boundary {
            UsageBoundary::Pause if self.phase == "recording" => ("pause", "paused"),
            UsageBoundary::Resume if self.phase == "paused" => ("resume", "recording"),
            UsageBoundary::Stop if matches!(self.phase, "recording" | "paused") => {
                ("stop", "stopped")
            }
            // A failed write may have a partial tail: close it, never claim a successful stop record.
            UsageBoundary::Stop if self.phase == "error" => {
                self.session = None;
                return Ok(self.status());
            }
            _ => {
                return Err(error(
                    "USAGE_INVALID_TRANSITION",
                    "Usage session transition is not available in this state.",
                ))
            }
        };
        let session = self.session.as_ref().ok_or_else(invalid)?;
        let record = boundary_record(
            &session.id,
            &session.source,
            &self.build,
            &session.tasks,
            session.sequence + 1,
            name,
            &now_iso()?,
        );
        self.persist(record, false)?;
        self.phase = next;
        Ok(self.status())
    }
    pub fn append(&mut self, input: UsageEventInput) -> Result<UsageStatus, UsageError> {
        if self.phase != "recording" {
            return Err(error(
                "USAGE_NOT_RECORDING",
                "Explicitly start or resume usage recording first.",
            ));
        }
        validate_event(&input)?;
        let session = self.session.as_ref().ok_or_else(invalid)?;
        if !session.tasks.is_empty() && input.task_ids.iter().any(|id| !session.tasks.contains(id))
        {
            return Err(invalid());
        }
        let now = now_iso()?;
        let occurred = input.occurred_at.as_deref().unwrap_or(&now);
        if !valid_iso(occurred)
            || occurred < session.last_occurred.as_str()
            || occurred > now.as_str()
        {
            return Err(error(
                "USAGE_CLOCK_INVALID",
                "Usage occurrence must be ordered within the current recording session.",
            ));
        }
        let mut record = json!({"kind":"event","eventId":format!("{}-{}",session.id,session.sequence+1),"sequence":session.sequence+1,"sessionId":session.id,"source":session.source,"build":self.build,"occurredAt":occurred,"collectedAt":now,"taskIds":input.task_ids,"scenarioId":input.scenario_id,"actionId":input.action_id,"resultCode":input.result_code});
        let fields = record.as_object_mut().ok_or_else(invalid)?;
        if let Some(v) = input.duration_ms {
            fields.insert("durationMs".into(), json!(v));
        }
        if let Some(v) = input.repo_id {
            fields.insert("repoId".into(), json!(v));
        }
        if let Some(v) = input.counts {
            fields.insert("counts".into(), json!(v));
        }
        if let Some(v) = input.state {
            fields.insert("state".into(), json!(v));
        }
        if let Some(v) = input.error_code {
            fields.insert("errorCode".into(), json!(v));
        }
        self.persist(record, true)?;
        Ok(self.status())
    }
    fn persist(&mut self, record: Value, event: bool) -> Result<(), UsageError> {
        let result = (|| {
            self.scan()?;
            let occurred = record
                .get("occurredAt")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .to_string();
            let collected = record
                .get("collectedAt")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .to_string();
            let session = self.session.as_ref().ok_or_else(invalid)?;
            if occurred < session.last_occurred || collected < session.last_collected {
                return Err(error(
                    "USAGE_CLOCK_INVALID",
                    "Usage clock moved backwards; recording stopped.",
                ));
            }
            let bytes = encode(&[record])?;
            let session = self.session.as_ref().ok_or_else(invalid)?;
            self.check_capacity(session.bytes, bytes.len() as u64)?;
            if session.file.metadata().map_err(io_error)?.len() != session.bytes {
                return Err(error(
                    "USAGE_EXTERNAL_CHANGE",
                    "Usage storage changed externally; recording paused.",
                ));
            }
            let session = self.session.as_mut().ok_or_else(invalid)?;
            session
                .file
                .write_all(&bytes)
                .and_then(|_| session.file.sync_all())
                .map_err(io_error)?;
            session.sequence += 1;
            session.last_occurred = occurred;
            session.last_collected = collected;
            session.events += u64::from(event);
            session.bytes += bytes.len() as u64;
            self.total_bytes += bytes.len() as u64;
            Ok(())
        })();
        if let Err(ref failure) = result {
            self.storage_failure(failure);
        }
        result
    }
    fn storage_failure(&mut self, failure: &UsageError) {
        self.phase = "error";
        self.error_code = Some(failure.code);
    }
    fn check_capacity(&self, current: u64, added: u64) -> Result<(), UsageError> {
        if current.saturating_add(added) > self.limits.session_bytes
            || self.total_bytes.saturating_add(added) > self.limits.global_bytes
        {
            return Err(error(
                "USAGE_FULL",
                "Usage capacity reached; recording stopped, no logs were deleted.",
            ));
        }
        Ok(())
    }
    fn scan(&mut self) -> Result<(), UsageError> {
        match fs::symlink_metadata(&self.directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.total_bytes = 0;
                self.session_count = 0;
                return Ok(());
            }
            Err(e) => return Err(io_error(e)),
            Ok(_) => reject_link(&self.directory)?,
        }
        let mut total = 0u64;
        let mut count = 0usize;
        for entry in fs::read_dir(&self.directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            reject_link(&entry.path())?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(invalid)?;
            let id = name.strip_suffix(".jsonl").ok_or_else(invalid)?;
            if !valid_session_id(id) || !entry.file_type().map_err(io_error)?.is_file() {
                return Err(error(
                    "USAGE_STORAGE_INVALID",
                    "Unexpected usage storage entry; review local logs offline.",
                ));
            }
            let length = entry.metadata().map_err(io_error)?.len();
            total = total.saturating_add(length);
            count += 1;
            if length > self.limits.session_bytes
                || total > self.limits.global_bytes
                || count > self.limits.session_count
            {
                return Err(error(
                    "USAGE_FULL",
                    "Existing usage storage exceeds capacity; no logs were deleted.",
                ));
            }
        }
        self.total_bytes = total;
        self.session_count = count;
        Ok(())
    }
}
fn reject_link(path: &Path) -> Result<(), UsageError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse {
        return Err(error(
            "USAGE_STORAGE_INVALID",
            "Usage storage must not contain links or redirected entries.",
        ));
    }
    Ok(())
}
fn encode(records: &[Value]) -> Result<Vec<u8>, UsageError> {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, record).map_err(|_| invalid())?;
        bytes.push(b'\n');
    }
    Ok(bytes)
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn validate_tasks(tasks: &[String]) -> Result<(), UsageError> {
    if tasks.len() > 100 {
        return Err(invalid());
    }
    for (index, id) in tasks.iter().enumerate() {
        let suffix = id.strip_prefix("QG-").ok_or_else(invalid)?;
        let numeric = suffix.len() == 3 && suffix.bytes().all(|b| b.is_ascii_digit());
        let named = !suffix.is_empty()
            && suffix.len() <= 64
            && suffix.as_bytes()[0].is_ascii_uppercase()
            && suffix
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-');
        if !(numeric || named) || tasks[..index].contains(id) {
            return Err(invalid());
        }
    }
    Ok(())
}
fn validate_event(event: &UsageEventInput) -> Result<(), UsageError> {
    validate_tasks(&event.task_ids)?;
    if ![&event.scenario_id, &event.action_id, &event.result_code]
        .iter()
        .all(|v| identifier(v))
        || event.duration_ms.is_some_and(|v| v > 86400000)
    {
        return Err(invalid());
    }
    if let Some(id) = &event.repo_id {
        if id.len() != 34
            || !id.starts_with("r-")
            || !id[2..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(invalid());
        }
    }
    if event
        .error_code
        .as_ref()
        .is_some_and(|v| !ERROR_CODES.contains(&v.as_str()))
    {
        return Err(invalid());
    }
    if let Some(counts) = &event.counts {
        for (key, value) in counts {
            if ![
                "selected",
                "files",
                "staged",
                "unstaged",
                "untracked",
                "commits",
                "conflicts",
                "changed",
                "total",
            ]
            .contains(&key.as_str())
                || value.as_u64().is_none_or(|v| v > 1_000_000_000)
            {
                return Err(invalid());
            }
        }
    }
    if let Some(state) = &event.state {
        for (key, value) in state {
            let valid = match key.as_str() {
                "trusted" | "busy" | "cancelled" => value.is_boolean(),
                "theme" => value
                    .as_str()
                    .is_some_and(|v| ["dark", "light"].contains(&v)),
                "viewport" => value
                    .as_str()
                    .is_some_and(|v| ["wide", "narrow"].contains(&v)),
                "status" => value.as_str().is_some_and(|v| {
                    [
                        "todo",
                        "ready",
                        "inprogress",
                        "readyforusage",
                        "done",
                        "blocked",
                        "archived",
                    ]
                    .contains(&v)
                }),
                "phase" => value.as_str().is_some_and(|v| {
                    [
                        "idle",
                        "preview",
                        "running",
                        "success",
                        "failed",
                        "cancelled",
                        "blocked",
                    ]
                    .contains(&v)
                }),
                _ => false,
            };
            if !valid {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
fn boundary_record(
    id: &str,
    source: &UsageSource,
    build: &str,
    tasks: &[String],
    sequence: u64,
    boundary: &str,
    now: &str,
) -> Value {
    json!({"kind":"boundary","boundary":boundary,"eventId":format!("{id}-{sequence}"),"sequence":sequence,"sessionId":id,"source":source,"build":build,"occurredAt":now,"collectedAt":now,"taskIds":if tasks.is_empty() {vec!["QG-NATIVE-USAGE".to_string()]} else {tasks.to_vec()},"scenarioId":format!("native-usage-{boundary}"),"actionId":format!("usage.{boundary}"),"resultCode":"OBSERVED"})
}
fn valid_session_id(value: &str) -> bool {
    value.len() == 38
        && value.starts_with("s-")
        && value[2..].bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
// IDs are collision-resistant identifiers, not authentication capabilities or identities.
fn session_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let random = RandomState::new();
    let mut a = random.build_hasher();
    a.write_u64(NEXT.fetch_add(1, Ordering::Relaxed));
    a.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    let first = a.finish();
    let mut b = random.build_hasher();
    b.write_u64(first);
    b.write_u32(std::process::id());
    let hex = format!("{:016x}{:016x}", first, b.finish());
    format!(
        "s-{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
fn valid_iso(value: &str) -> bool {
    if value.len() != 24
        || !value.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            19 => b == b'.',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        })
    {
        return false;
    }
    let number = |from: usize, to: usize| value[from..to].parse::<u32>().unwrap_or(u32::MAX);
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    (1970..=9999).contains(&year)
        && day >= 1
        && day <= days
        && number(11, 13) <= 23
        && number(14, 16) <= 59
        && number(17, 19) <= 59
}
fn now_iso() -> Result<String, UsageError> {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
        error(
            "USAGE_CLOCK_INVALID",
            "System clock cannot provide a valid usage timestamp.",
        )
    })?;
    let seconds = duration.as_secs();
    let days = (seconds / 86400) as i64;
    // Gregorian civil date conversion; no locale, timezone or external process.
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    if !(1970..=9999).contains(&year) {
        return Err(error(
            "USAGE_CLOCK_INVALID",
            "System clock is outside the supported recording range.",
        ));
    }
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        (seconds % 86400) / 3600,
        (seconds % 3600) / 60,
        seconds % 60,
        duration.subsec_millis()
    ))
}

// Streaming SHA-256, used only for runtime executable identity, not signatures or authentication.
struct Sha256 {
    state: [u32; 8],
    block: Vec<u8>,
    length: u64,
}
impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            block: Vec::with_capacity(64),
            length: 0,
        }
    }
    fn update(&mut self, bytes: &[u8]) {
        self.length += bytes.len() as u64;
        for byte in bytes {
            self.block.push(*byte);
            if self.block.len() == 64 {
                self.compress();
                self.block.clear();
            }
        }
    }
    fn compress(&mut self) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut w = [0u32; 64];
        for (i, chunk) in self.block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let t2 = s0.wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (target, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *target = target.wrapping_add(value);
        }
    }
    fn finish(mut self) -> String {
        let bits = self.length * 8;
        self.update(&[0x80]);
        while self.block.len() != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        self.state.iter().map(|v| format!("{v:08x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recorder() -> (tempfile::TempDir, UsageRecorder) {
        let directory = tempfile::tempdir().unwrap();
        let recorder = UsageRecorder::with_runtime(
            directory.path().into(),
            UsageRuntime {
                app_version: "0.3.0".into(),
                source_build: "source-unit".into(),
                source_build_reliable: true,
                exe_sha256: "a".repeat(64),
            },
        )
        .unwrap();
        (directory, recorder)
    }
    fn event() -> UsageEventInput {
        serde_json::from_value(json!({"taskIds":["QG-BOARD"],"scenarioId":"board-read","actionId":"board.open","resultCode":"OBSERVED","repoId":format!("r-{}","a".repeat(32)),"counts":{"files":1},"state":{"theme":"dark","viewport":"wide"}})).unwrap()
    }
    fn start(recorder: &mut UsageRecorder) {
        recorder
            .start(UsageStart {
                source: UsageSource::AutomatedTest,
                task_ids: vec![],
            })
            .unwrap();
    }
    #[test]
    fn sha256_known_vectors_and_streaming() {
        for (bytes, expected) in [
            (
                "",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                "abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
        ] {
            let mut h = Sha256::new();
            for b in bytes.bytes() {
                h.update(&[b]);
            }
            assert_eq!(h.finish(), expected);
        }
        let mut h = Sha256::new();
        h.update(&vec![b'a'; 1_000_000]);
        assert_eq!(
            h.finish(),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
    #[test]
    fn opt_in_boundaries_lock_provenance_and_restart_is_idle() {
        let (directory, mut recorder) = recorder();
        assert!(!directory.path().join("usage").exists());
        assert!(recorder.append(event()).is_err());
        start(&mut recorder);
        assert!(recorder
            .start(UsageStart {
                source: UsageSource::Userusage,
                task_ids: vec![]
            })
            .is_err());
        recorder.append(event()).unwrap();
        recorder.boundary(UsageBoundary::Pause).unwrap();
        assert!(recorder.append(event()).is_err());
        recorder.boundary(UsageBoundary::Resume).unwrap();
        recorder.append(event()).unwrap();
        recorder.boundary(UsageBoundary::Stop).unwrap();
        assert!(recorder.append(event()).is_err());
        let status = recorder.status();
        let bytes = fs::read_to_string(
            directory
                .path()
                .join("usage")
                .join(format!("{}.jsonl", status.session_id.unwrap())),
        )
        .unwrap();
        let records: Vec<Value> = bytes
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(records.len(), 7);
        for (i, record) in records.iter().skip(1).enumerate() {
            assert_eq!(record["sequence"], i + 1);
            assert_eq!(record["source"], "automated-test");
            assert_eq!(record["build"], format!("native-{}", "a".repeat(64)));
            assert_eq!(record["occurredAt"], record["collectedAt"]);
        }
        assert!(!bytes.contains(&directory.path().to_string_lossy().to_string()));
        drop(recorder);
        let restarted =
            UsageRecorder::new(directory.path().into(), "development", "0.3.0").unwrap();
        assert_eq!(restarted.status().phase, "idle");
        assert!(!restarted.status().runtime.source_build_reliable);
    }
    #[test]
    fn privacy_unknown_fields_and_nested_content_are_rejected() {
        let (_directory, mut recorder) = recorder();
        start(&mut recorder);
        for patch in [
            json!({"source":"userusage"}),
            json!({"build":"other"}),
            json!({"path":"private"}),
            json!({"message":"secret"}),
        ] {
            let mut value =
                json!({"taskIds":[],"scenarioId":"safe","actionId":"safe","resultCode":"OBSERVED"});
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(serde_json::from_value::<UsageEventInput>(value).is_err());
        }
        for mut e in [event(), event(), event(), event(), event()] {
            e.repo_id = Some("C:/private".into());
            assert!(recorder.append(e).is_err());
        }
        let mut e = event();
        e.counts = Some(serde_json::from_value(json!({"files":{"content":"secret"}})).unwrap());
        assert!(recorder.append(e).is_err());
        let mut e = event();
        e.state = Some(serde_json::from_value(json!({"branch":"private-name"})).unwrap());
        assert!(recorder.append(e).is_err());
        let mut e = event();
        e.error_code = Some("private-message".into());
        assert!(recorder.append(e).is_err());
        assert_eq!(recorder.status().event_count, 0);
    }
    #[test]
    fn capacity_and_partial_write_failures_remain_visible_and_keep_logs() {
        let (directory, mut recorder) = recorder();
        start(&mut recorder);
        let before = recorder.status().bytes;
        recorder.limits.session_bytes = before + 1;
        assert_eq!(recorder.append(event()).unwrap_err().code, "USAGE_FULL");
        assert_eq!(recorder.status().phase, "error");
        assert_eq!(recorder.status().error_code.as_deref(), Some("USAGE_FULL"));
        assert_eq!(
            fs::read_dir(directory.path().join("usage"))
                .unwrap()
                .count(),
            1
        );
        recorder.limits.session_bytes = SESSION_BYTES;
        recorder.boundary(UsageBoundary::Stop).unwrap();
        start(&mut recorder);
        let status = recorder.status();
        let path = directory
            .path()
            .join("usage")
            .join(format!("{}.jsonl", status.session_id.unwrap()));
        let mut external = OpenOptions::new().append(true).open(path).unwrap();
        external.write_all(b"{\"partial\"").unwrap();
        assert_eq!(
            recorder.append(event()).unwrap_err().code,
            "USAGE_EXTERNAL_CHANGE"
        );
        assert_eq!(recorder.status().phase, "error");
    }
    #[test]
    fn queued_occurrence_is_preserved_and_bad_or_cross_session_time_is_rejected() {
        let (directory, mut recorder) = recorder();
        start(&mut recorder);
        let occurred = now_iso().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        let mut e = event();
        e.occurred_at = Some(occurred.clone());
        recorder.append(e).unwrap();
        for value in [
            "private-path",
            "2026-02-30T00:00:00.000Z",
            "2000-01-01T00:00:00.000Z",
            "2099-01-01T00:00:00.000Z",
        ] {
            let mut e = event();
            e.occurred_at = Some(value.into());
            assert_eq!(recorder.append(e).unwrap_err().code, "USAGE_CLOCK_INVALID");
        }
        let path = directory
            .path()
            .join("usage")
            .join(format!("{}.jsonl", recorder.status().session_id.unwrap()));
        let records: Vec<Value> = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records[2]["occurredAt"], occurred);
        assert!(records[2]["collectedAt"].as_str().unwrap() > occurred.as_str());
    }
    #[test]
    fn session_limits_scope_and_id_format_are_enforced() {
        let (_directory, mut recorder) = recorder();
        recorder.limits.session_count = 0;
        assert_eq!(
            recorder
                .start(UsageStart {
                    source: UsageSource::Assistant,
                    task_ids: vec![]
                })
                .unwrap_err()
                .code,
            "USAGE_FULL"
        );
        recorder.limits.session_count = 1000;
        recorder
            .start(UsageStart {
                source: UsageSource::Assistant,
                task_ids: vec!["QG-USAGE".into()],
            })
            .unwrap();
        assert!(recorder.append(event()).is_err());
        assert!(valid_session_id(
            recorder.status().session_id.as_ref().unwrap()
        ));
        assert!(now_iso().unwrap().ends_with('Z'));
    }
}
