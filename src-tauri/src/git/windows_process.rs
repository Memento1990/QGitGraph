//! Private Windows fast path for GitService's sealed command builder, not a
//! general std::process::Command replacement. The builder sets only program,
//! args, cwd, environment deltas and stdio; env_clear/raw_arg/arg0/custom startup
//! settings are intentionally unsupported. Stdio is recreated here. No shell,
//! PID reopening, thread enumeration, undocumented API or Tokio file pipes.
#![cfg(windows)]

use super::{ProcessOutput, MAX_INPUT, MAX_OUTPUT};
use crate::{
    error::{AppError, Result},
    performance::Span,
};
use std::{
    cmp::Ordering,
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Read, Write},
    mem::{size_of, size_of_val, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    process::Command,
    ptr::{null, null_mut},
    sync::Arc,
    time::Duration,
};
use tokio::{task::JoinError, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::*,
    Globalization::{CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN},
    Security::SECURITY_ATTRIBUTES,
    System::{JobObjects::*, Pipes::CreatePipe, Threading::*},
};

#[derive(Clone)]
struct Job(Arc<OwnedHandle>);
impl Job {
    fn new() -> Result<Self> {
        // SAFETY: null security attributes make this owning handle non-inheritable.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(AppError::io(io::Error::last_os_error()));
        }
        let job = Self(Arc::new(unsafe { OwnedHandle::from_raw_handle(handle) }));
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                size_of_val(&limits) as u32,
            )
        })?;
        Ok(job)
    }
    fn terminate(&self) {
        // An explicit termination is necessary even while pipe workers own Arc
        // clones: merely closing NativeChild's clone would not close the Job.
        unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) };
    }
}

pub(crate) struct NativeChild {
    pub pid: u32,
    job: Job,
    process: Arc<OwnedHandle>,
    stdin: Option<File>,
    stdout: Option<File>,
    stderr: Option<File>,
}
impl Drop for NativeChild {
    fn drop(&mut self) {
        self.job.terminate();
    }
}

impl NativeChild {
    pub(crate) fn spawn(
        command: &Command,
        has_input: bool,
        request_id: &str,
        verb: &'static str,
    ) -> Result<Self> {
        let mut spec = LaunchSpec::from_command(command)?;
        let mut phase = Span::begin(request_id, "job-create", verb);
        let job = Job::new()?;
        phase.complete();
        drop(phase);
        let (child_in, parent_in) = pipe(true)?;
        let (child_out, parent_out) = pipe(false)?;
        let (child_err, parent_err) = pipe(false)?;
        let handles = [
            child_in.as_raw_handle(),
            child_out.as_raw_handle(),
            child_err.as_raw_handle(),
        ];
        let attributes = Attributes::new(&handles)?;
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.pointer();
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        let mut phase = Span::begin(request_id, "spawn", verb);
        // SAFETY: all UTF-16 buffers are NUL-terminated, command line is mutable,
        // and attributes/allowlisted handles remain alive through CreateProcessW.
        // An explicit absolute application name avoids all PATH/shell resolution.
        let created = unsafe {
            CreateProcessW(
                spec.program.as_ptr(),
                spec.arguments.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                spec.environment.as_ptr() as _,
                spec.cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        };
        if created == 0 {
            let error = io::Error::last_os_error();
            return Err(AppError::new(
                "GIT_UNAVAILABLE",
                format!("Could not start the isolated Git process: {error}"),
            ));
        }
        // SAFETY: successful CreateProcessW transfers ownership of exactly these
        // two handles. Retain its original hThread, not a later PID/thread lookup.
        let process = Arc::new(unsafe { OwnedHandle::from_raw_handle(info.hProcess) });
        let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
        let child = Self {
            pid: info.dwProcessId,
            job,
            process,
            stdin: has_input.then_some(parent_in),
            stdout: Some(parent_out),
            stderr: Some(parent_err),
        };
        // Parent copies of child endpoints must not keep EOF artificially open.
        drop((attributes, child_in, child_out, child_err));
        phase.complete();
        drop(phase);
        let setup = (|| {
            let mut phase = Span::begin(request_id, "job-attach", verb);
            check(unsafe {
                AssignProcessToJobObject(child.job.0.as_raw_handle(), child.process.as_raw_handle())
            })?;
            phase.complete();
            drop(phase);
            let mut phase = Span::begin(request_id, "resume", verb);
            let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
            if previous == u32::MAX {
                return Err(AppError::io(io::Error::last_os_error()));
            }
            if previous != 1 {
                return Err(AppError::new("PROCESS", "Unexpected Git suspension state."));
            }
            phase.complete();
            Ok(())
        })();
        if let Err(error) = setup {
            child.job.terminate();
            // Assignment can fail before the Job owns the suspended process.
            // The retained process handle is authoritative on that path too.
            unsafe {
                TerminateProcess(child.process.as_raw_handle(), 1);
                WaitForSingleObject(child.process.as_raw_handle(), INFINITE);
            }
            return Err(error);
        }
        Ok(child)
    }

    /// Parent must hold its six-slot permit and observer guard through this
    /// future. Exactly three blocking workers perform synchronous pipe I/O:
    /// stdout reader, stderr reader, and stdin writer followed by process wait.
    pub(crate) async fn collect(
        mut self,
        input: Option<Vec<u8>>,
        token: CancellationToken,
        timeout: Duration,
        request_id: &str,
        verb: &'static str,
    ) -> Result<ProcessOutput> {
        let mut execution = Span::begin(request_id, "execution", verb);
        if input.as_ref().is_some_and(|bytes| bytes.len() > MAX_INPUT) {
            self.job.terminate();
            let process = self.process.clone();
            let _ = tokio::task::spawn_blocking(move || wait(&process)).await;
            return Err(AppError::new(
                "INPUT_LIMIT",
                "Internal Git input exceeds 8 MiB.",
            ));
        }
        let mut out = read_worker(self.stdout.take().expect("owned stdout"), self.job.clone());
        let mut err = read_worker(self.stderr.take().expect("owned stderr"), self.job.clone());
        let mut stdin = self.stdin.take();
        let process = self.process.clone();
        let job = self.job.clone();
        let mut waiter = tokio::task::spawn_blocking(move || {
            let mut reap = WorkerReaper {
                process,
                job,
                waited: false,
            };
            let written = match (stdin.as_mut(), input) {
                (Some(stdin), Some(input)) => stdin.write_all(&input).map_err(|error| {
                    if error.kind() != io::ErrorKind::BrokenPipe {
                        reap.job.terminate();
                    }
                    AppError::io(error)
                }),
                _ => Ok(()),
            };
            drop(stdin); // EOF must precede waiting; never leave Git awaiting input.
            let status = wait(&reap.process);
            reap.waited = status.is_ok();
            status.map(|code| (code, written))
        });
        let mut stdout = None;
        let mut stderr = None;
        let mut interrupted = None;
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let status = loop {
            tokio::select! { biased;
                _ = token.cancelled() => {
                    interrupted = Some(super::cancelled_error());
                    break None;
                }
                _ = &mut deadline => {
                    interrupted = Some(AppError::new("TIMEOUT", "Git timed out. Check authentication, signing tools and repository state before retrying."));
                    break None;
                }
                result = &mut out, if stdout.is_none() => {
                    stdout = Some(joined(result, &self.job));
                }
                result = &mut err, if stderr.is_none() => {
                    stderr = Some(joined(result, &self.job));
                }
                result = &mut waiter => break Some(joined(result, &self.job)),
            }
        };
        // Also kill surviving helpers after a normal root exit. On cancellation,
        // terminate first, then join the actual writer/waiter, never detach it.
        self.job.terminate();
        let status = match status {
            Some(status) => status,
            None => joined(waiter.await, &self.job),
        };
        let code = status.as_ref().ok().map(|(code, _)| *code);
        execution.output(None, None, code);
        execution.outcome(outcome(
            interrupted.as_ref().or_else(|| {
                stdout
                    .as_ref()
                    .and_then(|v| v.as_ref().err())
                    .or_else(|| stderr.as_ref().and_then(|v| v.as_ref().err()))
            }),
            code,
        ));
        drop(execution);
        let mut drain = Span::begin(request_id, "drain", verb);
        // Poll both joins even if either worker failed or panicked. A JoinError
        // terminates the Job before awaiting the other reader.
        let (stdout, stderr) = tokio::join!(
            finish_reader(stdout, &mut out, &self.job),
            finish_reader(stderr, &mut err, &self.job),
        );
        drain.output(
            stdout.as_ref().ok().map(Vec::len),
            stderr.as_ref().ok().map(Vec::len),
            code,
        );
        if interrupted.is_none() && token.is_cancelled() {
            interrupted = Some(super::cancelled_error());
        }
        let result = (|| {
            if let Some(error) = interrupted {
                return Err(error);
            }
            let (code, written) = status?;
            let stdout = stdout?;
            let stderr = stderr?;
            // EPIPE is normal when Git rejects its input and exits nonzero.
            if code == 0 {
                written?;
            }
            Ok(ProcessOutput {
                code,
                stdout,
                stderr,
            })
        })();
        drain.outcome(outcome(result.as_ref().err(), code));
        result
    }
}

fn outcome(error: Option<&AppError>, code: Option<i32>) -> &'static str {
    match error.map(|error| error.code.as_str()) {
        Some("CANCELLED") => "cancelled",
        Some("TIMEOUT") => "timeout",
        Some("OUTPUT_LIMIT") => "output-limit",
        Some(_) => "error",
        None if code == Some(0) => "ok",
        None if code.is_some() => "exit",
        None => "error",
    }
}
fn joined<T>(result: std::result::Result<Result<T>, JoinError>, job: &Job) -> Result<T> {
    let result = result.map_err(AppError::io).and_then(|result| result);
    if result.is_err() {
        job.terminate();
    }
    result
}
async fn finish_reader(
    result: Option<Result<Vec<u8>>>,
    worker: &mut JoinHandle<Result<Vec<u8>>>,
    job: &Job,
) -> Result<Vec<u8>> {
    match result {
        Some(result) => result,
        None => joined(worker.await, job),
    }
}
fn read_worker(mut pipe: File, job: Job) -> JoinHandle<Result<Vec<u8>>> {
    tokio::task::spawn_blocking(move || {
        let result = (|| {
            let mut output = Vec::new();
            let mut chunk = [0; 32768];
            loop {
                let count = match pipe.read(&mut chunk) {
                    Ok(count) => count,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::BrokenPipe => 0,
                    Err(error) => return Err(AppError::io(error)),
                };
                if count == 0 {
                    return Ok(output);
                }
                if count > MAX_OUTPUT - output.len() {
                    return Err(AppError::new(
                        "OUTPUT_LIMIT",
                        "Git output exceeds 32 MiB. Narrow the query or select a smaller file.",
                    ));
                }
                output.extend_from_slice(&chunk[..count]);
            }
        })();
        if result.is_err() {
            job.terminate();
        }
        result
    })
}
// Exists only inside the blocking writer/wait worker. Even unwinding before
// wait must terminate and reap the retained process, never wait in async Drop.
struct WorkerReaper {
    process: Arc<OwnedHandle>,
    job: Job,
    waited: bool,
}
impl Drop for WorkerReaper {
    fn drop(&mut self) {
        if !self.waited {
            self.job.terminate();
            unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) };
        }
    }
}
fn wait(process: &OwnedHandle) -> Result<i32> {
    if unsafe { WaitForSingleObject(process.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
        return Err(AppError::io(io::Error::last_os_error()));
    }
    let mut code = 0;
    check(unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) })?;
    Ok(code as i32)
}
fn check(success: i32) -> Result<()> {
    if success == 0 {
        Err(AppError::io(io::Error::last_os_error()))
    } else {
        Ok(())
    }
}
fn pipe(child_reads: bool) -> Result<(OwnedHandle, File)> {
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (null_mut(), null_mut());
    check(unsafe { CreatePipe(&mut read, &mut write, &security, 0) })?;
    // SAFETY: successful CreatePipe transfers two independently owned handles.
    let read = unsafe { OwnedHandle::from_raw_handle(read) };
    let write = unsafe { OwnedHandle::from_raw_handle(write) };
    let (child, parent) = if child_reads {
        (read, write)
    } else {
        (write, read)
    };
    check(unsafe { SetHandleInformation(parent.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) })?;
    Ok((child, File::from(parent)))
}

// The storage is pointer-aligned; the borrowed handle array outlives the list.
struct Attributes<'a> {
    storage: Vec<usize>,
    _handles: &'a [HANDLE],
}
impl<'a> Attributes<'a> {
    fn pointer(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_ptr() as _
    }
    fn new(handles: &'a [HANDLE]) -> Result<Self> {
        let mut size = 0;
        let queried = unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        let error = io::Error::last_os_error();
        if queried != 0
            || error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
            || size == 0
        {
            return Err(AppError::io(error));
        }
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        check(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr() as _, 1, 0, &mut size)
        })?;
        let list = Self {
            storage,
            _handles: handles,
        };
        check(unsafe {
            UpdateProcThreadAttribute(
                list.pointer(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr() as _,
                size_of_val(handles),
                null_mut(),
                null(),
            )
        })?;
        Ok(list)
    }
}
impl Drop for Attributes<'_> {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

struct LaunchSpec {
    program: Vec<u16>,
    arguments: Vec<u16>,
    cwd: Option<Vec<u16>>,
    environment: Vec<u16>,
}
impl LaunchSpec {
    fn from_command(command: &Command) -> Result<Self> {
        if !Path::new(command.get_program()).is_absolute() {
            return Err(AppError::new(
                "GIT_UNAVAILABLE",
                "Git requires an absolute executable path.",
            ));
        }
        let mut arguments = Vec::new();
        for argument in std::iter::once(command.get_program()).chain(command.get_args()) {
            if !arguments.is_empty() {
                arguments.push(b' ' as u16);
            }
            quote(&units(argument)?, &mut arguments);
        }
        arguments.push(0);
        if arguments.len() > 32767 {
            return Err(AppError::new(
                "ARGUMENT",
                "The Git command line exceeds the Windows limit.",
            ));
        }
        Ok(Self {
            program: terminated(command.get_program())?,
            arguments,
            cwd: command
                .get_current_dir()
                .map(|path| terminated(path.as_os_str()))
                .transpose()?,
            environment: environment(command)?,
        })
    }
}
fn units(value: &OsStr) -> Result<Vec<u16>> {
    let units: Vec<_> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(AppError::new(
            "ARGUMENT",
            "Git launch data contains a NUL character.",
        ));
    }
    Ok(units)
}
fn terminated(value: &OsStr) -> Result<Vec<u16>> {
    let mut value = units(value)?;
    value.push(0);
    Ok(value)
}
// CRT quoting, including empty args and doubled trailing backslashes inside
// quotes. Always quoting is safe; shell metacharacters have no special meaning.
fn quote(argument: &[u16], output: &mut Vec<u16>) {
    output.push(b'"' as u16);
    let mut slashes = 0;
    for &unit in argument {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        let count = if unit == b'"' as u16 {
            slashes * 2 + 1
        } else {
            slashes
        };
        output.extend(std::iter::repeat_n(b'\\' as u16, count));
        output.push(unit);
        slashes = 0;
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
}
fn ordinal(left: &[u16], right: &[u16]) -> Result<Ordering> {
    let left_len = i32::try_from(left.len()).map_err(AppError::io)?;
    let right_len = i32::try_from(right.len()).map_err(AppError::io)?;
    match unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) } {
        CSTR_LESS_THAN => Ok(Ordering::Less),
        CSTR_EQUAL => Ok(Ordering::Equal),
        CSTR_GREATER_THAN => Ok(Ordering::Greater),
        _ => Err(AppError::io(io::Error::last_os_error())),
    }
}
fn environment(command: &Command) -> Result<Vec<u16>> {
    merge_environment(
        std::env::vars_os(),
        command
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(OsStr::to_owned))),
    )
}

// Keep inherited Windows pseudoentries separate from explicit settings/removals.
// vars_os() splits entries starting with '=' at the *next* '=': both drive cwd
// entries (=C:=...) and other shell metadata (=name=...) can be inherited. These
// are opaque OS data, not names callers may set or remove through the builder.
fn merge_environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    changes: impl IntoIterator<Item = (OsString, Option<OsString>)>,
) -> Result<Vec<u16>> {
    let mut entries = Vec::new();
    for (key, value) in inherited {
        let key = environment_key(&key, true)?;
        merge_environment_entry(&mut entries, key, Some(units(&value)?))?;
    }
    for (key, value) in changes {
        // Validate removals too, before looking up the name. An inherited
        // pseudoentry never grants permission to address it explicitly.
        let key = environment_key(&key, false)?;
        let value = value.as_deref().map(units).transpose()?;
        merge_environment_entry(&mut entries, key, value)?;
    }
    Ok(environment_block(&entries))
}

fn environment_key(key: &OsStr, inherited: bool) -> Result<Vec<u16>> {
    let key = units(key)?;
    let name = if inherited && key.first() == Some(&(b'=' as u16)) {
        &key[1..]
    } else {
        &key[..]
    };
    // Only inherited names may have one leading '='; a nonempty remainder
    // without another '=' is necessary to serialize one unambiguous entry.
    if name.is_empty() || name.contains(&(b'=' as u16)) {
        return Err(AppError::new(
            "ARGUMENT",
            "Invalid Git environment variable name.",
        ));
    }
    Ok(key)
}

fn merge_environment_entry(
    entries: &mut Vec<(Vec<u16>, Vec<u16>)>,
    key: Vec<u16>,
    value: Option<Vec<u16>>,
) -> Result<()> {
    // Fallible binary insertion uses Windows' locale-independent ordinal
    // comparison, not Unicode/ASCII lowercasing. Deletions are case-insensitive.
    let (mut low, mut high) = (0, entries.len());
    let mut found = false;
    while low < high {
        let middle = low + (high - low) / 2;
        match ordinal(&entries[middle].0, &key)? {
            Ordering::Less => low = middle + 1,
            Ordering::Greater => high = middle,
            Ordering::Equal => {
                low = middle;
                found = true;
                break;
            }
        }
    }
    if found {
        entries.remove(low);
    }
    if let Some(value) = value {
        entries.insert(low, (key, value));
    }
    Ok(())
}
fn environment_block(entries: &[(Vec<u16>, Vec<u16>)]) -> Vec<u16> {
    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(key);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crt_quote_edges_and_empty_environment_are_exact() {
        for (input, expected) in [
            ("", "\"\""),
            ("plain", "\"plain\""),
            ("a b", "\"a b\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\", "\"a\\\\\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
            ("中文 & | % !", "\"中文 & | % !\""),
        ] {
            let mut quoted = Vec::new();
            quote(&input.encode_utf16().collect::<Vec<_>>(), &mut quoted);
            assert_eq!(String::from_utf16(&quoted).unwrap(), expected, "{input:?}");
        }
        assert_eq!(environment_block(&[]), vec![0, 0]);
    }
    #[test]
    fn inherited_pseudoentries_and_ordinal_overlays_form_an_exact_utf16_block() {
        let inherited = [
            ("z", "last"),
            ("=QGITGRAPH_METADATA", "中文=quoted\"\\😀"),
            ("=C:", r"C:\directory 中文"),
            ("=c:", r"C:\replacement 中文"),
            ("=::", "shell metadata"),
            ("=qgitgraph_metadata", "replacement=中文😀"),
            ("QGITGRAPH_É", "old"),
            ("qgitgraph_é", "inherited duplicate"),
            ("QGITGRAPH_REMOVED_É", "old"),
            ("Empty", ""),
        ]
        .map(|(key, value)| (OsString::from(key), OsString::from(value)));
        let changes = [
            ("qgitgraph_é", Some("explicit=quoted\"\\中文😀")),
            ("qgitgraph_removed_é", None),
            ("not_present", None),
            ("Added", Some("")),
        ]
        .map(|(key, value)| (OsString::from(key), value.map(OsString::from)));
        let block = merge_environment(inherited, changes).unwrap();
        let expected: Vec<_> = concat!(
            "=::=shell metadata\0",
            "=c:=C:\\replacement 中文\0",
            "=qgitgraph_metadata=replacement=中文😀\0",
            "Added=\0",
            "Empty=\0",
            "qgitgraph_é=explicit=quoted\"\\中文😀\0",
            "z=last\0\0",
        )
        .encode_utf16()
        .collect();
        assert_eq!(block, expected);
        // Pseudoentry keys use the same Windows ordinal comparison as ordinary
        // keys, including non-ASCII folding, rather than ASCII normalization.
        assert_eq!(
            merge_environment(
                [("=É", "old"), ("=é", "new")]
                    .map(|(key, value)| (OsString::from(key), OsString::from(value))),
                [],
            )
            .unwrap(),
            "=é=new\0\0".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(merge_environment([], []).unwrap(), vec![0, 0]);
        assert_eq!(
            merge_environment(
                [(OsString::from("Remove"), OsString::from("value"))],
                [(OsString::from("rEMOVE"), None)],
            )
            .unwrap(),
            vec![0, 0]
        );
        // Windows ordinal case folding does not expand one name into another.
        assert_ne!(
            ordinal(
                &"Straße".encode_utf16().collect::<Vec<_>>(),
                &"STRASSE".encode_utf16().collect::<Vec<_>>()
            )
            .unwrap(),
            Ordering::Equal
        );
    }

    #[test]
    fn inherited_environment_rejects_malformed_names_and_nuls() {
        for key in [
            "",
            "=",
            "==",
            "=name=extra",
            "ordinary=name",
            "bad\0name",
            "=bad\0name",
        ] {
            let error = merge_environment(
                [(OsString::from(key), OsString::from("synthetic value"))],
                [],
            )
            .unwrap_err();
            assert_eq!(error.code, "ARGUMENT", "synthetic key {key:?}");
        }
        for key in ["ordinary", "=C:", "=metadata"] {
            assert_eq!(
                merge_environment([(OsString::from(key), OsString::from("bad\0value"))], [])
                    .unwrap_err()
                    .code,
                "ARGUMENT"
            );
        }
    }

    #[test]
    fn explicit_environment_settings_and_removals_never_accept_pseudonames() {
        for key in [
            "",
            "=C:",
            "=c:",
            "=metadata",
            "=::",
            "=É😀",
            "=",
            "==",
            "=name=extra",
            "ordinary=name",
            "bad\0name",
            "=bad\0name",
        ] {
            for value in [Some(OsString::from("synthetic value")), None] {
                // Even an inherited matching pseudoentry cannot be explicitly
                // overridden or removed. The empty-inheritance case matters too.
                for inherited in [
                    Vec::new(),
                    vec![
                        (OsString::from("=C:"), OsString::from(r"C:\synthetic")),
                        (OsString::from("=metadata"), OsString::from("opaque")),
                    ],
                ] {
                    let error =
                        merge_environment(inherited, [(OsString::from(key), value.clone())])
                            .unwrap_err();
                    assert_eq!(error.code, "ARGUMENT", "synthetic key {key:?}");
                }
            }
        }
        assert_eq!(
            merge_environment(
                [],
                [(
                    OsString::from("ordinary"),
                    Some(OsString::from("bad\0value"))
                )],
            )
            .unwrap_err()
            .code,
            "ARGUMENT"
        );
    }

    #[test]
    fn explicit_command_adapter_validates_both_settings_and_removals() {
        for key in ["=C:", "=metadata", "=::", "ordinary=name", ""] {
            for remove in [false, true] {
                let mut command = Command::new(r"C:\trusted\git.exe");
                if remove {
                    command.env_remove(key);
                } else {
                    command.env(key, "synthetic");
                }
                assert_eq!(
                    environment(&command).unwrap_err().code,
                    "ARGUMENT",
                    "synthetic key {key:?}, remove={remove}"
                );
            }
        }
    }

    #[test]
    fn environment_preserves_non_unicode_utf16_without_lossy_conversion() {
        use std::os::windows::ffi::OsStringExt;
        let key = [b'=' as u16, 0xd800, b'X' as u16];
        let value = [0xdc00, b'=' as u16, 0xd83d, 0xde00];
        let mut expected = key.to_vec();
        expected.push(b'=' as u16);
        expected.extend(value);
        expected.extend([0, 0]);
        assert_eq!(
            merge_environment(
                [(OsString::from_wide(&key), OsString::from_wide(&value))],
                [],
            )
            .unwrap(),
            expected
        );
        assert_eq!(
            units(&OsString::from_wide(&[b'a' as u16, 0, b'b' as u16]))
                .unwrap_err()
                .code,
            "ARGUMENT"
        );
    }
}
