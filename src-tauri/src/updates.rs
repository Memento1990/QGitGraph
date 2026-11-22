use crate::error::{AppError, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering as VersionOrdering,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_NOTES_BYTES: usize = 16 * 1024;
const READ_CHUNK_BYTES: usize = 16 * 1024;
const MAX_TAG_BYTES: usize = 128;
const MAX_TIMESTAMP_BYTES: usize = 64;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const PHASE_TIMEOUT: Duration = Duration::from_secs(5);
const RELEASE_URL_PREFIX: &str = "https://github.com/Memento1990/QGitGraph/releases/tag/";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUpdateInfo {
    pub status: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_tag: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    /// Untrusted release text, not HTML. Consumers must render this as plain text.
    pub release_notes: Option<String>,
    pub notes_truncated: bool,
}

impl GithubUpdateInfo {
    fn without_release(status: &str, current_version: &str) -> Self {
        Self {
            status: status.to_owned(),
            current_version: current_version.to_owned(),
            latest_version: None,
            release_tag: None,
            release_url: None,
            published_at: None,
            release_notes: None,
            notes_truncated: false,
        }
    }
}

/// An explicitly invoked, uncached check of this application's public releases.
#[derive(Clone)]
pub struct UpdateService {
    in_flight: Arc<AtomicBool>,
}

impl Default for UpdateService {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateService {
    pub fn new() -> Self {
        Self {
            in_flight: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn check(&self) -> Result<GithubUpdateInfo> {
        self.check_with(fetch_latest).await
    }

    // This private seam is for offline tests; callers cannot supply URLs or credentials.
    async fn check_with<F>(&self, fetch: F) -> Result<GithubUpdateInfo>
    where
        F: FnOnce(&Deadline) -> Result<FetchResult> + Send + 'static,
    {
        let guard = InFlightGuard::acquire(Arc::clone(&self.in_flight))?;
        tokio::task::spawn_blocking(move || {
            // Ownership stays in the worker, not in the awaiting future. Aborting an
            // IPC caller must not permit a second check while native I/O continues.
            let _guard = guard;
            let deadline = Deadline::new(CHECK_TIMEOUT);
            let fetched = deadline.run(|| fetch(&deadline))?;
            deadline.run(|| update_info(CURRENT_VERSION, fetched))
        })
        .await
        .map_err(|_| {
            AppError::new(
                "UPDATE_INTERNAL",
                "The update check could not be completed.",
            )
        })?
    }
}

struct InFlightGuard(Arc<AtomicBool>);

impl InFlightGuard {
    fn acquire(flag: Arc<AtomicBool>) -> Result<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AppError::new("UPDATE_BUSY", "An update check is already in progress."))?;
        Ok(Self(flag))
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct Deadline {
    started: Instant,
    limit: Duration,
}

impl Deadline {
    fn new(limit: Duration) -> Self {
        Self {
            started: Instant::now(),
            limit,
        }
    }

    fn remaining(&self) -> Result<Duration> {
        self.limit
            .checked_sub(self.started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(timeout_error)
    }

    fn phase_timeout_millis(&self) -> Result<i32> {
        // Never pass zero: WinHTTP interprets it as an infinite timeout.
        Ok(self.remaining()?.min(PHASE_TIMEOUT).as_millis().max(1) as i32)
    }

    fn run<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        self.remaining()?;
        let result = operation();
        self.remaining()?;
        result
    }
}

fn timeout_error() -> AppError {
    AppError::new(
        "UPDATE_TIMEOUT",
        "The update check timed out. Try again later.",
    )
}

fn response_error() -> AppError {
    AppError::new(
        "UPDATE_RESPONSE",
        "GitHub returned invalid release information.",
    )
}

fn too_large_error() -> AppError {
    AppError::new(
        "UPDATE_TOO_LARGE",
        "GitHub returned release information that exceeds the size limit.",
    )
}

fn auth_error() -> AppError {
    AppError::new(
        "UPDATE_AUTH_REQUIRED",
        "GitHub or your proxy requires authentication. This check does not send credentials.",
    )
}

enum FetchResult {
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    Response(HttpResponse),
}

struct HttpResponse {
    status: u32,
    rate_limit_remaining: Option<u64>,
    body: Vec<u8>,
}

#[derive(Deserialize)]
struct GithubRelease {
    draft: bool,
    prerelease: bool,
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
}

fn update_info(current_version: &str, fetched: FetchResult) -> Result<GithubUpdateInfo> {
    let response = match fetched {
        FetchResult::Unsupported => {
            return Ok(GithubUpdateInfo::without_release(
                "unsupported",
                current_version,
            ));
        }
        FetchResult::Response(response) => response,
    };
    match response.status {
        200 => {}
        404 => {
            return Ok(GithubUpdateInfo::without_release(
                "no-release",
                current_version,
            ));
        }
        401 | 407 => return Err(auth_error()),
        429 => return Err(rate_limit_error()),
        403 if response.rate_limit_remaining == Some(0) => return Err(rate_limit_error()),
        _ => {
            return Err(AppError::new(
                "UPDATE_HTTP",
                "GitHub returned an unexpected response. Try again later.",
            ));
        }
    }
    if response.body.len() > MAX_BODY_BYTES {
        return Err(too_large_error());
    }
    // Parsing errors deliberately omit both the response text and serde's details.
    let body = std::str::from_utf8(&response.body).map_err(|_| response_error())?;
    let release: GithubRelease = serde_json::from_str(body).map_err(|_| response_error())?;
    if release.draft || release.prerelease {
        return Err(response_error());
    }
    let latest = stable_tag_version(&release.tag_name)?;
    validate_release_url(&release.html_url, &release.tag_name)?;
    if release
        .published_at
        .as_deref()
        .is_some_and(|value| !valid_rfc3339(value))
    {
        return Err(response_error());
    }
    let current = Version::parse(current_version).map_err(|_| {
        AppError::new(
            "UPDATE_INTERNAL",
            "The installed application version could not be checked.",
        )
    })?;
    let (release_notes, notes_truncated) = bounded_notes(release.body);
    Ok(GithubUpdateInfo {
        status: if latest.cmp_precedence(&current) == VersionOrdering::Greater {
            "available"
        } else {
            "current"
        }
        .to_owned(),
        current_version: current_version.to_owned(),
        latest_version: Some(latest.to_string()),
        release_tag: Some(release.tag_name),
        release_url: Some(release.html_url),
        published_at: release.published_at,
        release_notes,
        notes_truncated,
    })
}

fn rate_limit_error() -> AppError {
    AppError::new(
        "UPDATE_RATE_LIMIT",
        "GitHub has temporarily limited update checks. Try again later.",
    )
}

fn stable_tag_version(tag: &str) -> Result<Version> {
    if tag.is_empty()
        || tag.len() > MAX_TAG_BYTES
        || !tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
    {
        return Err(response_error());
    }
    let normalized = tag.strip_prefix('v').unwrap_or(tag);
    let version = Version::parse(normalized).map_err(|_| response_error())?;
    if !version.pre.is_empty() || version.to_string() != normalized {
        return Err(response_error());
    }
    Ok(version)
}

fn validate_release_url(value: &str, tag: &str) -> Result<()> {
    let expected = format!("{RELEASE_URL_PREFIX}{tag}");
    // Byte equality rejects even URL-parser-normalized ports, dot segments,
    // whitespace, percent escapes, backslashes, or credentials.
    if value != expected {
        return Err(response_error());
    }
    let parsed = url::Url::parse(value).map_err(|_| response_error())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != format!("/Memento1990/QGitGraph/releases/tag/{tag}")
        || parsed.as_str() != expected
    {
        return Err(response_error());
    }
    Ok(())
}

fn bounded_notes(notes: Option<String>) -> (Option<String>, bool) {
    let Some(mut notes) = notes else {
        return (None, false);
    };
    if notes.len() <= MAX_NOTES_BYTES {
        return (Some(notes), false);
    }
    let mut end = MAX_NOTES_BYTES;
    while !notes.is_char_boundary(end) {
        end -= 1;
    }
    notes.truncate(end);
    (Some(notes), true)
}

fn valid_rfc3339(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(20..=MAX_TIMESTAMP_BYTES).contains(&bytes.len()) || !value.is_ascii() {
        return false;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }
    let decimal = |range: std::ops::Range<usize>| -> Option<u32> {
        bytes[range].iter().try_fold(0, |number, byte| {
            byte.is_ascii_digit()
                .then_some(number * 10 + u32::from(byte.wrapping_sub(b'0')))
        })
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        decimal(0..4),
        decimal(5..7),
        decimal(8..10),
        decimal(11..13),
        decimal(14..16),
        decimal(17..19),
    ) else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days || hour > 23 || minute > 59 || second > 60 {
        return false;
    }
    let mut offset = 19;
    if bytes[offset] == b'.' {
        offset += 1;
        let first_digit = offset;
        while offset < bytes.len() && bytes[offset].is_ascii_digit() {
            offset += 1;
        }
        if offset == first_digit {
            return false;
        }
    }
    match bytes.get(offset) {
        Some(b'Z' | b'z') => offset + 1 == bytes.len(),
        Some(b'+' | b'-') if offset + 6 == bytes.len() && bytes[offset + 3] == b':' => {
            decimal(offset + 1..offset + 3).is_some_and(|hour| hour <= 23)
                && decimal(offset + 4..offset + 6).is_some_and(|minute| minute <= 59)
        }
        _ => false,
    }
}

fn parse_decimal_header(value: &str) -> Option<u64> {
    let value = value.trim_matches([' ', '\t']);
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn bounded_read_len(available: u32, buffer_length: usize) -> usize {
    (available as usize)
        .min(buffer_length)
        .min(READ_CHUNK_BYTES)
}

fn read_bounded_body(
    declared_length: Option<u64>,
    mut read: impl FnMut(&mut [u8]) -> Result<usize>,
) -> Result<Vec<u8>> {
    if declared_length.is_some_and(|length| length > MAX_BODY_BYTES as u64) {
        return Err(too_large_error());
    }
    // Content-Length is neither an allocation size nor a trusted actual byte count.
    let mut body = Vec::new();
    let mut buffer = [0_u8; READ_CHUNK_BYTES];
    loop {
        let allowed = READ_CHUNK_BYTES.min(MAX_BODY_BYTES - body.len() + 1);
        let length = read(&mut buffer[..allowed])?;
        if length > allowed {
            return Err(response_error());
        }
        if length == 0 {
            return Ok(body);
        }
        if length > MAX_BODY_BYTES - body.len() {
            return Err(too_large_error());
        }
        body.extend_from_slice(&buffer[..length]);
    }
}

#[cfg(windows)]
fn fetch_latest(deadline: &Deadline) -> Result<FetchResult> {
    winhttp::fetch(deadline)
}

#[cfg(not(windows))]
fn fetch_latest(_deadline: &Deadline) -> Result<FetchResult> {
    Ok(FetchResult::Unsupported)
}

#[cfg(windows)]
mod winhttp {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, size_of_val},
        ptr::{null, null_mut, NonNull},
    };
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER},
        Networking::WinHttp::*,
    };

    const API_HOST: &str = "api.github.com";
    const API_PATH: &str = "/repos/Memento1990/QGitGraph/releases/latest";
    const REQUEST_HEADERS: &str =
        "Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2022-11-28\r\n";

    struct InternetHandle(NonNull<c_void>);

    impl InternetHandle {
        fn new(raw: *mut c_void) -> Result<Self> {
            NonNull::new(raw)
                .map(Self)
                .ok_or_else(|| native_error(unsafe { GetLastError() }))
        }

        fn raw(&self) -> *mut c_void {
            self.0.as_ptr()
        }
    }

    impl Drop for InternetHandle {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.raw());
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn native_error(code: u32) -> AppError {
        match code {
            ERROR_WINHTTP_TIMEOUT => timeout_error(),
            ERROR_WINHTTP_LOGIN_FAILURE
            | ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED
            | ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED_PROXY => auth_error(),
            ERROR_WINHTTP_SECURE_CERT_CN_INVALID
            | ERROR_WINHTTP_SECURE_CERT_DATE_INVALID
            | ERROR_WINHTTP_SECURE_CERT_REVOKED
            | ERROR_WINHTTP_SECURE_CERT_REV_FAILED
            | ERROR_WINHTTP_SECURE_CERT_WRONG_USAGE
            | ERROR_WINHTTP_SECURE_CHANNEL_ERROR
            | ERROR_WINHTTP_SECURE_FAILURE
            | ERROR_WINHTTP_SECURE_FAILURE_PROXY
            | ERROR_WINHTTP_SECURE_INVALID_CA
            | ERROR_WINHTTP_SECURE_INVALID_CERT => AppError::new(
                "UPDATE_TLS",
                "A secure connection to GitHub could not be verified.",
            ),
            _ => AppError::new(
                "UPDATE_NETWORK",
                "Could not reach GitHub. Check your network connection and try again.",
            ),
        }
    }

    fn checked(success: i32) -> Result<()> {
        if success == 0 {
            Err(native_error(unsafe { GetLastError() }))
        } else {
            Ok(())
        }
    }

    fn set_u32(handle: &InternetHandle, option: u32, value: u32) -> Result<()> {
        checked(unsafe {
            WinHttpSetOption(
                handle.raw(),
                option,
                (&value as *const u32).cast(),
                size_of::<u32>() as u32,
            )
        })
    }

    fn io<T>(
        handle: &InternetHandle,
        deadline: &Deadline,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let timeout = deadline.phase_timeout_millis()?;
        checked(unsafe { WinHttpSetTimeouts(handle.raw(), timeout, timeout, timeout, timeout) })?;
        // A synchronous call is not force-cancelled at the elapsed deadline. Each
        // native I/O phase has a finite timeout, and the elapsed budget is checked
        // before and after every call (including DNS, send, receive, and reads).
        deadline.run(operation)
    }

    fn header(
        request: &InternetHandle,
        deadline: &Deadline,
        query: u32,
        name: Option<&str>,
    ) -> Result<Option<String>> {
        let name = name.map(wide);
        io(request, deadline, || {
            // Never allocate from a server-supplied header length.
            let mut buffer = [0_u16; 128];
            let mut bytes = size_of_val(&buffer) as u32;
            let success = unsafe {
                WinHttpQueryHeaders(
                    request.raw(),
                    query,
                    name.as_ref().map_or(null(), |name| name.as_ptr()),
                    buffer.as_mut_ptr().cast(),
                    &mut bytes,
                    null_mut(),
                )
            };
            if success == 0 {
                let error = unsafe { GetLastError() };
                return match error {
                    ERROR_WINHTTP_HEADER_NOT_FOUND => Ok(None),
                    ERROR_INSUFFICIENT_BUFFER => Err(response_error()),
                    _ => Err(native_error(error)),
                };
            }
            let length = bytes as usize / size_of::<u16>();
            if bytes as usize % size_of::<u16>() != 0 || length > buffer.len() {
                return Err(response_error());
            }
            let value = &buffer[..length];
            let value = value.strip_suffix(&[0]).unwrap_or(value);
            String::from_utf16(value)
                .map(Some)
                .map_err(|_| response_error())
        })
    }

    pub(super) fn fetch(deadline: &Deadline) -> Result<FetchResult> {
        let agent = wide(&format!("QGitGraph/{CURRENT_VERSION}"));
        let host = wide(API_HOST);
        let method = wide("GET");
        let path = wide(API_PATH);
        let headers = wide(REQUEST_HEADERS);
        let session = deadline.run(|| {
            InternetHandle::new(unsafe {
                WinHttpOpen(
                    agent.as_ptr(),
                    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                    null(),
                    null(),
                    0,
                )
            })
        })?;
        let connection = io(&session, deadline, || {
            InternetHandle::new(unsafe {
                WinHttpConnect(session.raw(), host.as_ptr(), INTERNET_DEFAULT_HTTPS_PORT, 0)
            })
        })?;
        let request = deadline.run(|| {
            InternetHandle::new(unsafe {
                WinHttpOpenRequest(
                    connection.raw(),
                    method.as_ptr(),
                    path.as_ptr(),
                    null(),
                    null(),
                    null(),
                    WINHTTP_FLAG_SECURE,
                )
            })
        })?;
        deadline.run(|| {
            set_u32(
                &request,
                WINHTTP_OPTION_AUTOLOGON_POLICY,
                WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH,
            )?;
            set_u32(
                &request,
                WINHTTP_OPTION_REDIRECT_POLICY,
                WINHTTP_OPTION_REDIRECT_POLICY_NEVER,
            )?;
            set_u32(
                &request,
                WINHTTP_OPTION_DISABLE_FEATURE,
                WINHTTP_DISABLE_COOKIES
                    | WINHTTP_DISABLE_REDIRECTS
                    | WINHTTP_DISABLE_AUTHENTICATION,
            )?;
            set_u32(&request, WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE, 64 * 1024)
        })?;
        // No credentials, auth callbacks, certificate exceptions, request body,
        // cookies, repository settings, or alternate endpoints are used.
        io(&request, deadline, || {
            checked(unsafe {
                WinHttpSendRequest(
                    request.raw(),
                    headers.as_ptr(),
                    (headers.len() - 1) as u32,
                    null(),
                    0,
                    0,
                    0,
                )
            })
        })?;
        io(&request, deadline, || {
            checked(unsafe { WinHttpReceiveResponse(request.raw(), null_mut()) })
        })?;
        let status = io(&request, deadline, || {
            let mut status = 0_u32;
            let mut bytes = size_of::<u32>() as u32;
            checked(unsafe {
                WinHttpQueryHeaders(
                    request.raw(),
                    WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                    null(),
                    (&mut status as *mut u32).cast(),
                    &mut bytes,
                    null_mut(),
                )
            })?;
            if bytes != size_of::<u32>() as u32 {
                return Err(response_error());
            }
            Ok(status)
        })?;
        let rate_limit_remaining = if status == 403 {
            header(
                &request,
                deadline,
                WINHTTP_QUERY_CUSTOM,
                Some("X-RateLimit-Remaining"),
            )?
            .as_deref()
            .and_then(parse_decimal_header)
        } else {
            None
        };
        if status != 200 {
            // Error bodies are neither read nor parsed, logged, or returned.
            return Ok(FetchResult::Response(HttpResponse {
                status,
                rate_limit_remaining,
                body: Vec::new(),
            }));
        }
        let declared_length = header(&request, deadline, WINHTTP_QUERY_CONTENT_LENGTH, None)?
            .as_deref()
            .and_then(parse_decimal_header);
        let body = read_bounded_body(declared_length, |buffer| {
            let mut available = 0_u32;
            io(&request, deadline, || {
                checked(unsafe { WinHttpQueryDataAvailable(request.raw(), &mut available) })
            })?;
            if available == 0 {
                return Ok(0);
            }
            let requested = bounded_read_len(available, buffer.len()) as u32;
            let mut actual = 0_u32;
            io(&request, deadline, || {
                checked(unsafe {
                    WinHttpReadData(
                        request.raw(),
                        buffer.as_mut_ptr().cast(),
                        requested,
                        &mut actual,
                    )
                })
            })?;
            if actual > requested {
                return Err(response_error());
            }
            Ok(actual as usize)
        })?;
        Ok(FetchResult::Response(HttpResponse {
            status,
            rate_limit_remaining,
            body,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::{atomic::AtomicUsize, mpsc};

    fn release(tag: &str) -> Value {
        json!({
            "draft": false,
            "prerelease": false,
            "tag_name": tag,
            "html_url": format!("{RELEASE_URL_PREFIX}{tag}"),
            "published_at": "2026-11-22T12:34:56Z",
            "body": "Release notes."
        })
    }

    fn response(status: u32, remaining: Option<u64>, body: Vec<u8>) -> FetchResult {
        FetchResult::Response(HttpResponse {
            status,
            rate_limit_remaining: remaining,
            body,
        })
    }

    fn release_response(value: Value) -> FetchResult {
        response(200, None, serde_json::to_vec(&value).unwrap())
    }

    fn check_release(current: &str, tag: &str) -> GithubUpdateInfo {
        update_info(current, release_response(release(tag))).unwrap()
    }

    fn assert_error_code<T: std::fmt::Debug>(result: Result<T>, expected: &str) {
        let error = result.unwrap_err();
        assert_eq!(error.code, expected);
        assert!(error.detail.is_none());
    }

    #[test]
    fn dto_uses_camel_case_and_explicit_empty_fields() {
        let value =
            serde_json::to_value(GithubUpdateInfo::without_release("no-release", "0.2.2")).unwrap();
        assert_eq!(
            value,
            json!({
                "status": "no-release",
                "currentVersion": "0.2.2",
                "latestVersion": null,
                "releaseTag": null,
                "releaseUrl": null,
                "publishedAt": null,
                "releaseNotes": null,
                "notesTruncated": false
            })
        );
    }

    #[test]
    fn optional_lowercase_v_is_normalized() {
        for tag in ["v0.2.3", "0.2.3"] {
            let info = check_release("0.2.2", tag);
            assert_eq!(info.status, "available");
            assert_eq!(info.latest_version.as_deref(), Some("0.2.3"));
            assert_eq!(info.release_tag.as_deref(), Some(tag));
        }
    }

    #[test]
    fn semver_is_numeric_not_lexicographic() {
        assert_eq!(check_release("0.9.9", "v0.10.0").status, "available");
        assert_eq!(check_release("0.10.0", "v0.9.9").status, "current");
        assert_eq!(check_release("2.0.0", "v10.0.0").status, "available");
    }

    #[test]
    fn equal_or_newer_installed_version_is_current() {
        assert_eq!(check_release("0.2.2", "v0.2.2").status, "current");
        let info = check_release("0.3.0", "v0.2.2");
        assert_eq!(info.status, "current");
        assert_eq!(info.current_version, "0.3.0");
        assert_eq!(info.latest_version.as_deref(), Some("0.2.2"));
    }

    #[test]
    fn build_metadata_is_preserved_but_does_not_change_precedence() {
        let info = check_release("0.2.2+installed", "v0.2.2+release.001-x");
        assert_eq!(info.status, "current");
        assert_eq!(info.latest_version.as_deref(), Some("0.2.2+release.001-x"));
        assert_eq!(
            info.release_url.as_deref(),
            Some("https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.2+release.001-x")
        );
        assert_eq!(check_release("0.2.2+z", "v0.2.3+a").status, "available");
    }

    #[test]
    fn a_stable_release_can_update_a_prerelease_install() {
        assert_eq!(check_release("0.2.2-rc.1", "v0.2.2").status, "available");
        assert_eq!(check_release("0.3.0-rc.1", "v0.2.2").status, "current");
    }

    #[test]
    fn tags_require_canonical_stable_ascii_semver() {
        for tag in [
            "",
            "v",
            "V0.2.2",
            "vv0.2.2",
            "0.2",
            "0.2.2.0",
            "01.2.2",
            "0.02.2",
            "0.2.02",
            "v0.2.2-rc.1",
            "0.2.2-0",
            " 0.2.2",
            "0.2.2\n",
            "０.2.2",
            "0.2.2/other",
            "0.2.2\\other",
            "0.2.2%2fother",
            "0.2.2+",
            "0.2.2+a..b",
            "0.2.2+a+b",
        ] {
            assert_error_code(stable_tag_version(tag), "UPDATE_RESPONSE");
        }
        let huge = format!("0.2.2+{}", "a".repeat(MAX_TAG_BYTES));
        assert_error_code(stable_tag_version(&huge), "UPDATE_RESPONSE");
        assert!(stable_tag_version("v1.2.3+001.Build-name").is_ok());
    }

    #[test]
    fn draft_and_prerelease_flags_are_rejected() {
        for field in ["draft", "prerelease"] {
            let mut value = release("v0.2.3");
            value[field] = json!(true);
            assert_error_code(
                update_info("0.2.2", release_response(value)),
                "UPDATE_RESPONSE",
            );
        }
        let mut value = release("v0.2.3-rc.1");
        value["prerelease"] = json!(false);
        assert_error_code(
            update_info("0.2.2", release_response(value)),
            "UPDATE_RESPONSE",
        );
    }

    #[test]
    fn required_release_fields_are_not_defaulted_or_coerced() {
        for field in ["draft", "prerelease", "tag_name", "html_url"] {
            let mut missing = release("v0.2.3");
            missing.as_object_mut().unwrap().remove(field);
            assert_error_code(
                update_info("0.2.2", release_response(missing)),
                "UPDATE_RESPONSE",
            );
            let mut null = release("v0.2.3");
            null[field] = Value::Null;
            assert_error_code(
                update_info("0.2.2", release_response(null)),
                "UPDATE_RESPONSE",
            );
        }
        let mut value = release("v0.2.3");
        value["draft"] = json!("false");
        assert_error_code(
            update_info("0.2.2", release_response(value)),
            "UPDATE_RESPONSE",
        );
    }

    #[test]
    fn release_urls_must_be_byte_exact_for_this_repository_and_tag() {
        let canonical = format!("{RELEASE_URL_PREFIX}v0.2.3");
        assert!(validate_release_url(&canonical, "v0.2.3").is_ok());
        for malicious in [
            "http://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://github.com.evil.test/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://github.com@evil.test/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://name@github.com/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://name:secret@github.com/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://github.com:443/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://github.com:444/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://github.com/Other/QGitGraph/releases/tag/v0.2.3",
            "https://github.com/Memento1990/Other/releases/tag/v0.2.3",
            "https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.4",
            "https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3?download=1",
            "https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3#notes",
            "https://github.com/Memento1990/QGitGraph/releases/tag/%760.2.3",
            "https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3%2fother",
            "https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3%5cother",
            "https://github.com/Memento1990/QGitGraph/releases/../releases/tag/v0.2.3",
            "https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3/",
            "https://GITHUB.COM/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://github.com\\Memento1990/QGitGraph/releases/tag/v0.2.3",
            "https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3\n",
            " https://github.com/Memento1990/QGitGraph/releases/tag/v0.2.3",
            "javascript:alert(1)",
        ] {
            assert_error_code(validate_release_url(malicious, "v0.2.3"), "UPDATE_RESPONSE");
        }
    }

    #[test]
    fn optional_release_fields_can_be_absent_or_null() {
        for remove in [false, true] {
            let mut value = release("v0.2.3");
            for field in ["published_at", "body"] {
                if remove {
                    value.as_object_mut().unwrap().remove(field);
                } else {
                    value[field] = Value::Null;
                }
            }
            let info = update_info("0.2.2", release_response(value)).unwrap();
            assert!(info.published_at.is_none());
            assert!(info.release_notes.is_none());
            assert!(!info.notes_truncated);
        }
    }

    #[test]
    fn published_timestamp_requires_bounded_rfc3339() {
        for valid in [
            "2026-11-22T12:34:56Z",
            "2024-02-29T23:59:59.123456789Z",
            "2000-02-29t00:00:00z",
            "2026-11-22T12:34:56+05:30",
            "2026-11-22T12:34:56.1-00:00",
            "2016-12-31T23:59:60Z",
        ] {
            assert!(valid_rfc3339(valid), "{valid}");
        }
        for invalid in [
            "",
            "2026-11-22",
            "2026-11-22 12:34:56Z",
            "2026-11-22T12:34:56",
            "2026-11-22T12:34:56.Z",
            "2026-11-22T12:34:56Ztrailing",
            "2026-11-22T12:34:56+0530",
            "2026-11-22T12:34:56+24:00",
            "2026-11-22T12:34:56+00:60",
            "2026-13-22T12:34:56Z",
            "2026-00-22T12:34:56Z",
            "2026-11-00T12:34:56Z",
            "2026-11-31T12:34:56Z",
            "2026-02-29T12:34:56Z",
            "1900-02-29T12:34:56Z",
            "2026-11-22T24:34:56Z",
            "2026-11-22T12:60:56Z",
            "2026-11-22T12:34:61Z",
            "2026-11-22T12:34:56Z\n",
            "２０２６-11-22T12:34:56Z",
        ] {
            assert!(!valid_rfc3339(invalid), "{invalid}");
        }
        assert!(!valid_rfc3339(&format!(
            "2026-11-22T12:34:56.{}Z",
            "1".repeat(MAX_TIMESTAMP_BYTES)
        )));
        let mut value = release("v0.2.3");
        value["published_at"] = json!("not a timestamp");
        assert_error_code(
            update_info("0.2.2", release_response(value)),
            "UPDATE_RESPONSE",
        );
    }

    #[test]
    fn only_404_means_no_public_latest_release() {
        let info = update_info("0.2.2", response(404, None, vec![0xff, 0xfe])).unwrap();
        assert_eq!(info.status, "no-release");
        assert!(info.latest_version.is_none());
        assert!(info.release_url.is_none());
        assert!(info.release_notes.is_none());
        for status in [201, 204, 301, 302, 400, 403, 500, 502, 503] {
            assert_error_code(
                update_info("0.2.2", response(status, None, Vec::new())),
                "UPDATE_HTTP",
            );
        }
    }

    #[test]
    fn rate_limits_are_conservative_and_auth_is_explicit() {
        for (status, remaining, expected) in [
            (403, Some(0), "UPDATE_RATE_LIMIT"),
            (403, Some(1), "UPDATE_HTTP"),
            (403, None, "UPDATE_HTTP"),
            (429, None, "UPDATE_RATE_LIMIT"),
            (429, Some(10), "UPDATE_RATE_LIMIT"),
            (401, None, "UPDATE_AUTH_REQUIRED"),
            (407, None, "UPDATE_AUTH_REQUIRED"),
        ] {
            assert_error_code(
                update_info("0.2.2", response(status, remaining, Vec::new())),
                expected,
            );
        }
    }

    #[test]
    fn untrusted_error_bodies_and_parse_errors_never_escape() {
        let secret = "secret-token-from-untrusted-response";
        for status in [200, 401, 403, 407, 429, 500] {
            let error = update_info("0.2.2", response(status, None, secret.as_bytes().to_vec()))
                .unwrap_err();
            assert!(!error.message.contains(secret));
            assert!(error.detail.is_none());
        }
    }

    #[test]
    fn json_must_be_complete_utf8_with_correct_field_types() {
        for body in [
            Vec::new(),
            b"not json".to_vec(),
            b"[]".to_vec(),
            b"null".to_vec(),
            vec![0xff, 0xfe],
            [
                serde_json::to_vec(&release("v0.2.3")).unwrap(),
                b" garbage".to_vec(),
            ]
            .concat(),
        ] {
            assert_error_code(
                update_info("0.2.2", response(200, None, body)),
                "UPDATE_RESPONSE",
            );
        }
        let mut value = release("v0.2.3");
        value["body"] = json!({"html": "not a string"});
        assert_error_code(
            update_info("0.2.2", release_response(value)),
            "UPDATE_RESPONSE",
        );
        let mut body = serde_json::to_vec(&release("v0.2.3")).unwrap();
        body.pop();
        body.extend_from_slice(b",\"draft\":false}");
        assert_error_code(
            update_info("0.2.2", response(200, None, body)),
            "UPDATE_RESPONSE",
        );
    }

    #[test]
    fn response_body_limit_is_checked_before_json_parsing() {
        assert_error_code(
            update_info("0.2.2", response(200, None, vec![b' '; MAX_BODY_BYTES + 1])),
            "UPDATE_TOO_LARGE",
        );
    }

    #[test]
    fn notes_are_plain_text_and_truncated_at_a_utf8_boundary() {
        let mut value = release("v0.2.3");
        let prefix = "a".repeat(MAX_NOTES_BYTES - 1);
        value["body"] = json!(format!("{prefix}é<script>alert('untrusted')</script>"));
        let info = update_info("0.2.2", release_response(value)).unwrap();
        assert!(info.notes_truncated);
        assert_eq!(info.release_notes.as_deref(), Some(prefix.as_str()));
        let mut value = release("v0.2.3");
        let untrusted = "<script>alert('untrusted')</script>\n**not rendered HTML**";
        value["body"] = json!(untrusted);
        let info = update_info("0.2.2", release_response(value)).unwrap();
        assert_eq!(info.release_notes.as_deref(), Some(untrusted));
        assert!(!info.notes_truncated);
    }

    #[test]
    fn exact_note_limit_and_empty_notes_are_not_marked_truncated() {
        for notes in [String::new(), "a".repeat(MAX_NOTES_BYTES)] {
            let (bounded, truncated) = bounded_notes(Some(notes.clone()));
            assert_eq!(bounded, Some(notes));
            assert!(!truncated);
        }
        assert_eq!(bounded_notes(None), (None, false));
        let unicode = "🦀".repeat(MAX_NOTES_BYTES / 4 + 1);
        let (notes, truncated) = bounded_notes(Some(unicode));
        assert_eq!(notes.unwrap().len(), MAX_NOTES_BYTES);
        assert!(truncated);
    }

    #[test]
    fn decimal_headers_are_optional_bounded_and_never_signed() {
        assert_eq!(parse_decimal_header(" 0\t"), Some(0));
        assert_eq!(parse_decimal_header("524288"), Some(524288));
        assert_eq!(parse_decimal_header("18446744073709551615"), Some(u64::MAX));
        for invalid in [
            "",
            " ",
            "+0",
            "-0",
            "1.0",
            "1e4",
            "0\r\n",
            "０",
            "18446744073709551616",
        ] {
            assert_eq!(parse_decimal_header(invalid), None);
        }
    }

    #[test]
    fn declared_oversize_is_rejected_without_reading_or_allocating_from_header() {
        let mut reads = 0;
        assert_error_code(
            read_bounded_body(Some(u64::MAX), |_| {
                reads += 1;
                Ok(0)
            }),
            "UPDATE_TOO_LARGE",
        );
        assert_eq!(reads, 0);
    }

    #[test]
    fn missing_or_lying_content_length_cannot_bypass_actual_body_limit() {
        for declared in [None, Some(0), Some(1), Some(MAX_BODY_BYTES as u64)] {
            let mut total_read = 0;
            assert_error_code(
                read_bounded_body(declared, |buffer| {
                    assert!(!buffer.is_empty());
                    assert!(buffer.len() <= READ_CHUNK_BYTES);
                    buffer.fill(b'x');
                    total_read += buffer.len();
                    Ok(buffer.len())
                }),
                "UPDATE_TOO_LARGE",
            );
            assert_eq!(total_read, MAX_BODY_BYTES + 1);
        }
    }

    #[test]
    fn exact_body_limit_reads_until_eof_without_truncating() {
        let mut remaining = MAX_BODY_BYTES;
        let body = read_bounded_body(None, |buffer| {
            let length = remaining.min(buffer.len());
            buffer[..length].fill(b'x');
            remaining -= length;
            Ok(length)
        })
        .unwrap();
        assert_eq!(body.len(), MAX_BODY_BYTES);
        assert!(body.iter().all(|byte| *byte == b'x'));
        assert_eq!(remaining, 0);
    }

    #[test]
    fn native_available_counts_never_control_allocation_or_large_reads() {
        assert_eq!(bounded_read_len(u32::MAX, MAX_BODY_BYTES), READ_CHUNK_BYTES);
        assert_eq!(bounded_read_len(u32::MAX, 1), 1);
        assert_eq!(bounded_read_len(3, READ_CHUNK_BYTES), 3);
        assert_eq!(bounded_read_len(0, READ_CHUNK_BYTES), 0);
        assert_error_code(
            read_bounded_body(None, |buffer| Ok(buffer.len() + 1)),
            "UPDATE_RESPONSE",
        );
    }

    #[test]
    fn read_failures_are_not_mistaken_for_eof_or_current() {
        assert_error_code(
            read_bounded_body(None, |_| Err(timeout_error())),
            "UPDATE_TIMEOUT",
        );
    }

    #[test]
    fn phase_timeouts_are_finite_and_clamped_to_remaining_budget() {
        let deadline = Deadline::new(CHECK_TIMEOUT);
        assert_eq!(deadline.phase_timeout_millis().unwrap(), 5000);
        let deadline = Deadline::new(Duration::from_secs(2));
        assert!((1..=2000).contains(&deadline.phase_timeout_millis().unwrap()));
        let deadline = Deadline::new(Duration::ZERO);
        assert_error_code(deadline.phase_timeout_millis(), "UPDATE_TIMEOUT");
    }

    #[test]
    fn expired_deadline_does_not_start_another_phase() {
        let deadline = Deadline::new(Duration::ZERO);
        let mut called = false;
        let result = deadline.run(|| {
            called = true;
            Ok(())
        });
        assert_error_code(result, "UPDATE_TIMEOUT");
        assert!(!called);
    }

    #[test]
    fn deadline_is_rechecked_after_a_blocking_operation_finishes() {
        let deadline = Deadline::new(Duration::from_millis(20));
        let result = deadline.run(|| {
            std::thread::sleep(Duration::from_millis(25));
            Ok(())
        });
        assert_error_code(result, "UPDATE_TIMEOUT");
    }

    #[tokio::test]
    async fn default_service_and_unpolled_future_do_not_fetch() {
        let service = UpdateService::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = Arc::clone(&calls);
        let future = service.check_with(move |_| {
            worker_calls.fetch_add(1, Ordering::SeqCst);
            Ok(release_response(release("v0.2.3")))
        });
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!service.in_flight.load(Ordering::Acquire));
        drop(future);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn busy_flag_resets_after_errors_and_repeated_checks_are_uncached() {
        let service = UpdateService::new();
        assert_error_code(
            service.check_with(|_| Err(timeout_error())).await,
            "UPDATE_TIMEOUT",
        );
        assert!(!service.in_flight.load(Ordering::Acquire));
        let calls = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let worker_calls = Arc::clone(&calls);
            service
                .check_with(move |_| {
                    worker_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(release_response(release("v0.2.3")))
                })
                .await
                .unwrap();
            assert!(!service.in_flight.load(Ordering::Acquire));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_checks_share_singleflight_even_across_service_clones() {
        let service = UpdateService::new();
        let worker_service = service.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = tokio::spawn(async move {
            worker_service
                .check_with(move |_| {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(release_response(release("v0.2.3")))
                })
                .await
        });
        started_rx.await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = Arc::clone(&calls);
        assert_error_code(
            service
                .check_with(move |_| {
                    worker_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(release_response(release("v0.2.3")))
                })
                .await,
            "UPDATE_BUSY",
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        release_tx.send(()).unwrap();
        first.await.unwrap().unwrap();
        assert!(!service.in_flight.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn dropped_caller_does_not_release_singleflight_while_worker_runs() {
        let service = UpdateService::new();
        let worker_service = service.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let caller = tokio::spawn(async move {
            worker_service
                .check_with(move |_| {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(release_response(release("v0.2.3")))
                })
                .await
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(service.in_flight.load(Ordering::Acquire));
        assert_error_code(
            service.check_with(|_| Ok(FetchResult::Unsupported)).await,
            "UPDATE_BUSY",
        );
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while service.in_flight.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            service
                .check_with(|_| Ok(FetchResult::Unsupported))
                .await
                .unwrap()
                .status,
            "unsupported"
        );
    }

    #[tokio::test]
    async fn worker_panic_releases_busy_flag_without_exposing_panic_details() {
        let service = UpdateService::new();
        assert_error_code(
            service
                .check_with(|_| panic!("private fake transport panic"))
                .await,
            "UPDATE_INTERNAL",
        );
        assert!(!service.in_flight.load(Ordering::Acquire));
        assert!(service
            .check_with(|_| Ok(FetchResult::Unsupported))
            .await
            .is_ok());
    }

    #[test]
    fn unsupported_transport_is_not_reported_as_current() {
        let info = update_info("0.2.2", FetchResult::Unsupported).unwrap();
        assert_eq!(info.status, "unsupported");
        assert!(info.latest_version.is_none());
        assert!(info.release_url.is_none());
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn non_windows_check_has_no_network_fallback() {
        let info = UpdateService::default().check().await.unwrap();
        assert_eq!(info.status, "unsupported");
        assert_eq!(info.current_version, CURRENT_VERSION);
    }
}
