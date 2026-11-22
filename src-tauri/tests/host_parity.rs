//! Real host parity checks, not parser mocks. Every repository, key, helper and
//! Git configuration is temporary; no test contacts a network, edits global
//! configuration, or mutates the test runner's environment. The only executable
//! permitted as a repository helper is our own build-only Rust probe.

use qgitgraph_lib::{
    error::Result,
    git::{sanitize_environment, GitService, ProcessOutput},
    model::{Repository, VerificationResult, VerifyQuery},
};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
const ENV_CHILD: &str = "QGITGRAPH_HOST_PARITY_ENV_CHILD";
const PROBE_COMMAND: &str = "qgitgraph-host-probe";

struct Fixture {
    directory: TempDir,
    home: PathBuf,
    path: PathBuf,
    service: GitService,
    repo: Repository,
    exec_path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-host-")
            .tempdir()
            .unwrap();
        let home = directory.path().join("isolated home");
        let path = directory.path().join("repo with spaces 中文");
        let exec_path = directory.path().join("only our test helper");
        for child in [
            &home,
            &path,
            &exec_path,
            &directory.path().join("empty templates"),
            &directory.path().join("empty hooks"),
        ] {
            fs::create_dir_all(child).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home.clone());
        let repo = Repository {
            id: "host-parity-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "host parity isolated repository".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: true,
            bare: false,
        };
        let fixture = Self {
            directory,
            home,
            path,
            service,
            repo,
            exec_path,
        };
        let templates = fixture.directory.path().join("empty templates");
        fixture.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--template",
            templates.to_str().unwrap(),
        ]);
        for (key, value) in [
            ("user.name", "Host parity temporary signer"),
            ("user.email", "host-parity@example.test"),
            ("core.autocrlf", "false"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            (
                "core.hooksPath",
                fixture
                    .directory
                    .path()
                    .join("empty hooks")
                    .to_str()
                    .unwrap(),
            ),
        ] {
            fixture.git(&["config", "--local", key, value]);
        }
        let helper = fixture.exec_path.join(if cfg!(windows) {
            "git-qgitgraph-host-probe.exe"
        } else {
            "git-qgitgraph-host-probe"
        });
        fs::copy(probe_executable(), &helper)
            .expect("copy only our build-only probe into an otherwise empty Git exec-path");
        fixture
    }

    fn command(&self, executable: &Path) -> Command {
        let mut command = Command::new(executable);
        command
            .current_dir(&self.path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        command
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "false")
            .env("GCM_INTERACTIVE", "Never")
            .env("GIT_AUTHOR_DATE", "@1704067200 +0000")
            .env("GIT_COMMITTER_DATE", "@1704067200 +0000");
        command
    }

    fn git_output(&self, args: &[&str], input: Option<&[u8]>) -> Output {
        let mut command = self.command(&self.service.git_path());
        command
            .args(["--no-pager", "-c", "color.ui=false"])
            .args(args);
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command
            .spawn()
            .unwrap_or_else(|error| panic!("start fixture Git {args:?}: {error}"));
        if let Some(input) = input {
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(input).unwrap();
        }
        child.wait_with_output().unwrap()
    }

    fn git_bytes(&self, args: &[&str], input: Option<&[u8]>) -> Vec<u8> {
        let output = self.git_output(args, input);
        assert!(
            output.status.success(),
            "fixture Git {args:?} failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn git(&self, args: &[&str]) -> String {
        String::from_utf8(self.git_bytes(args, None))
            .unwrap()
            .trim_end()
            .to_owned()
    }

    fn log_directory(&self, name: &str) -> PathBuf {
        let directory = self.directory.path().join(name);
        fs::create_dir(&directory).unwrap();
        directory
    }

    fn helper_args(&self, args: &[&str]) -> Vec<String> {
        let mut command = vec![
            format!("--exec-path={}", self.exec_path.display()),
            PROBE_COMMAND.into(),
        ];
        command.extend(args.iter().map(|value| (*value).to_owned()));
        command
    }

    async fn verify(&self, kind: &str, target: &str, request: &str) -> Result<VerificationResult> {
        self.service
            .verify_signature(
                &self.repo,
                &VerifyQuery {
                    repo_id: self.repo.id.clone(),
                    request_id: request.into(),
                    kind: kind.into(),
                    target: target.into(),
                },
            )
            .await
    }

    fn signed_objects(&self) -> (String, String) {
        let keygen = ssh_keygen().expect(
            "host-tests prerequisite: install ssh-keygen to run real SSH cryptographic tests",
        );
        let key = self.home.join("ephemeral-test-ed25519");
        // Intentionally passphrase-free: this new key is solely a throwaway
        // test fixture and is deleted with its isolated TempDir, never reused.
        let output = self
            .command(&keygen)
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "qgitgraph-temporary-host-test",
                "-f",
            ])
            .arg(&key)
            .output()
            .expect("start installed ssh-keygen without a shell");
        assert!(
            output.status.success(),
            "ephemeral ssh-keygen failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let public = fs::read_to_string(key.with_extension("pub")).unwrap();
        let allowed = self.home.join("allowed_signers");
        fs::write(
            &allowed,
            format!("host-parity@example.test {}\n", public.trim()),
        )
        .unwrap();
        let program = slash_path(&keygen);
        for (name, value) in [
            ("gpg.format", "ssh"),
            ("gpg.ssh.program", program.as_str()),
            ("user.signingkey", key.to_str().unwrap()),
            ("gpg.ssh.allowedSignersFile", allowed.to_str().unwrap()),
        ] {
            self.git(&["config", "--local", name, value]);
        }
        self.git(&[
            "commit",
            "--quiet",
            "--allow-empty",
            "-S",
            "--message",
            "original signed commit payload",
        ]);
        let commit = self.git(&["rev-parse", "HEAD"]);
        self.git(&[
            "tag",
            "-s",
            "--message",
            "original signed tag payload",
            "signed-host-tag",
            &commit,
        ]);
        let tag = self.git(&["rev-parse", "refs/tags/signed-host-tag"]);
        (commit, tag)
    }
}

fn probe_executable() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_qgitgraph-test-probe"));
    assert!(
        path.is_absolute() && path.is_file(),
        "Cargo must build our test-only probe: {}",
        path.display()
    );
    path
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn quote_for_git_ssh(path: &Path) -> String {
    // Git's documented core.sshCommand shell splitting is used solely for a
    // fixed, self-built executable and our TempDir. No user command is read.
    format!("'{}'", slash_path(path).replace('\'', "'\\''"))
}

fn ssh_keygen() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            candidates.push(PathBuf::from(root).join("System32/OpenSSH/ssh-keygen.exe"));
        }
        if let Some(base) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(base).join("Git/usr/bin/ssh-keygen.exe"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path).filter(|path| path.is_absolute()) {
            candidates.push(directory.join(if cfg!(windows) {
                "ssh-keygen.exe"
            } else {
                "ssh-keygen"
            }));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_absolute() && path.is_file())
}

async fn bounded_output(
    fixture: &Fixture,
    request: &str,
    args: Vec<String>,
    input: Option<Vec<u8>>,
    write: bool,
) -> Result<ProcessOutput> {
    match tokio::time::timeout(
        Duration::from_secs(25),
        fixture
            .service
            .run_output(&fixture.repo, request, args, input, write),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            fixture.service.cancel(request);
            panic!("host runner exceeded test deadline for {request}");
        }
    }
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, WAIT_TIMEOUT,
        },
        System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };
    unsafe {
        let process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if process.is_null() {
            let error = GetLastError();
            assert!(
                matches!(error, ERROR_INVALID_PARAMETER | ERROR_ACCESS_DENIED),
                "unexpected OpenProcess({pid}) error {error}"
            );
            return error == ERROR_ACCESS_DENIED;
        }
        let status = WaitForSingleObject(process, 0);
        CloseHandle(process);
        status == WAIT_TIMEOUT
    }
}

#[cfg(windows)]
struct ProcessCleanup {
    service: GitService,
    request: String,
    directory: PathBuf,
    root: Option<u32>,
}

#[cfg(windows)]
impl ProcessCleanup {
    fn new(service: &GitService, request: &str, directory: &Path) -> Self {
        Self {
            service: service.clone(),
            request: request.into(),
            directory: directory.into(),
            root: None,
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessCleanup {
    fn drop(&mut self) {
        // This is only a last-resort cleanup after an assertion failure. Actual
        // disappearance assertions are made before this guard is dropped.
        self.service.cancel(&self.request);
        let mut pids: Vec<u32> = self.root.into_iter().collect();
        for role in ["probe", "child", "grandchild"] {
            if let Ok(pid) = fs::read_to_string(self.directory.join(format!("{role}.pid"))) {
                if let Ok(pid) = pid.trim().parse() {
                    pids.push(pid);
                }
            }
        }
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
            };
            for pid in pids {
                let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
                if !process.is_null() {
                    TerminateProcess(process, 99);
                    CloseHandle(process);
                }
            }
        }
    }
}

#[cfg(windows)]
async fn wait_started(service: &GitService, request: &str, directory: &Path) -> Vec<u32> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if directory.join("ready").is_file() {
            let root = service
                .active_process(request)
                .expect("real Git must still be registered while helper sleeps");
            let mut pids = vec![root];
            for role in ["probe", "child", "grandchild"] {
                let pid = fs::read_to_string(directory.join(format!("{role}.pid")))
                    .unwrap()
                    .trim()
                    .parse::<u32>()
                    .unwrap();
                assert!(
                    process_is_alive(pid),
                    "{role} PID {pid} must actually be live before cancellation or overflow"
                );
                pids.push(pid);
            }
            let unique: std::collections::BTreeSet<_> = pids.iter().collect();
            assert_eq!(
                unique.len(),
                4,
                "Git, helper, child and grandchild must be different real processes"
            );
            assert!(
                process_is_alive(root),
                "registered Git PID must actually be live"
            );
            return pids;
        }
        assert!(
            Instant::now() < deadline,
            "probe did not start; active Git PID: {:?}; files: {:?}",
            service.active_process(request),
            fs::read_dir(directory)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(windows)]
async fn assert_processes_gone(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let live: Vec<_> = pids
            .iter()
            .copied()
            .filter(|pid| process_is_alive(*pid))
            .collect();
        if live.is_empty() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "runner leaked real Windows process IDs {live:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_live_ssh_helper_reaps_git_children_and_grandchildren() {
    let fixture = Fixture::new();
    let directory = fixture.log_directory("cancel live SSH helper");
    let request = "host-live-ssh-cancel";
    let ssh = format!(
        "{} --tree {}",
        quote_for_git_ssh(&probe_executable()),
        quote_for_git_ssh(&directory)
    );
    let args = vec![
        "-c".into(),
        format!("core.sshCommand={ssh}"),
        "-c".into(),
        "ssh.variant=ssh".into(),
        "fetch".into(),
        "--no-tags".into(),
        "ssh://example.invalid/testing".into(),
    ];
    let service = fixture.service.clone();
    let repo = fixture.repo.clone();
    let mut cleanup = ProcessCleanup::new(&service, request, &directory);
    let task =
        tokio::spawn(async move { service.run_output(&repo, request, args, None, true).await });
    let pids = wait_started(&fixture.service, request, &directory).await;
    cleanup.root = Some(pids[0]);
    assert_eq!(fixture.service.active_process(request), Some(pids[0]));
    let recorded = fs::read_to_string(directory.join("arguments.txt")).unwrap();
    assert!(
        recorded.contains("example.invalid") && recorded.contains("git-upload-pack"),
        "Git must invoke our probe as its real SSH helper: {recorded}"
    );
    let cwd = fs::read_to_string(directory.join("cwd.txt")).unwrap();
    assert_eq!(
        fs::canonicalize(cwd.trim()).unwrap(),
        fs::canonicalize(&fixture.path).unwrap()
    );
    fixture.service.cancel(request);
    let error = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("cancelled process tree must settle")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "CANCELLED", "{error:?}");
    assert_eq!(fixture.service.active_process(request), None);
    assert_processes_gone(&pids).await;
    // Reusing the exact request ID proves that neither registration nor a stale
    // cancellation tombstone makes the next real Git command unusable.
    let next = bounded_output(&fixture, request, vec!["--version".into()], None, false)
        .await
        .unwrap();
    assert_eq!(next.code, 0);
    assert!(String::from_utf8_lossy(&next.stdout).starts_with("git version "));
    assert_eq!(fixture.service.active_process(request), None);
}

#[tokio::test]
async fn cancel_before_registration_is_consumed_once_and_next_command_runs() {
    let fixture = Fixture::new();
    let request = "host-cancel-before-registration";
    fixture.service.cancel(request);
    let error = bounded_output(&fixture, request, vec!["--version".into()], None, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    assert_eq!(fixture.service.active_process(request), None);
    let next = bounded_output(&fixture, request, vec!["--version".into()], None, false)
        .await
        .unwrap();
    assert_eq!(next.code, 0);
    assert!(String::from_utf8_lossy(&next.stdout).starts_with("git version "));
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_stdout_and_stderr_over_32_mib_abort_and_reap_process_tree() {
    let fixture = Fixture::new();
    for stream in ["stdout", "stderr"] {
        let directory = fixture.log_directory(&format!("overflow {stream}"));
        let request = format!("host-overflow-{stream}");
        let count = (OUTPUT_LIMIT + 65536).to_string();
        let args =
            fixture.helper_args(&["--emit-tree", directory.to_str().unwrap(), stream, &count]);
        let service = fixture.service.clone();
        let repo = fixture.repo.clone();
        let task_id = request.clone();
        let mut cleanup = ProcessCleanup::new(&service, &request, &directory);
        let task =
            tokio::spawn(
                async move { service.run_output(&repo, &task_id, args, None, true).await },
            );
        let pids = wait_started(&fixture.service, &request, &directory).await;
        cleanup.root = Some(pids[0]);
        fs::write(
            directory.join("release"),
            b"emit only after all processes observed live",
        )
        .unwrap();
        let error = tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .expect("output limiter must terminate runaway process")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "OUTPUT_LIMIT", "{stream}: {error:?}");
        assert_eq!(fixture.service.active_process(&request), None);
        assert_processes_gone(&pids).await;
        let next = bounded_output(&fixture, &request, vec!["--version".into()], None, false)
            .await
            .unwrap();
        assert_eq!(
            next.code, 0,
            "service remains usable after {stream} overflow"
        );
    }
}

#[tokio::test]
async fn exactly_32_mib_is_allowed_and_binary_stdin_reaches_real_helper() {
    let fixture = Fixture::new();
    let count = OUTPUT_LIMIT.to_string();
    let output = bounded_output(
        &fixture,
        "host-exact-output-limit",
        fixture.helper_args(&["--emit", "stdout", &count]),
        None,
        true,
    )
    .await
    .unwrap();
    assert_eq!(output.code, 0);
    assert_eq!(output.stdout.len(), OUTPUT_LIMIT);
    assert!(output.stdout.iter().all(|value| *value == b'Q'));
    assert!(output.stderr.is_empty());
    let input = b"stdin\0binary\xff\nUTF-8: \xe4\xb8\xad\xe6\x96\x87".to_vec();
    let bytes = fixture
        .service
        .run_with_input(
            &fixture.repo,
            "host-real-binary-stdin",
            fixture.helper_args(&["--echo-input"]),
            input.clone(),
            true,
        )
        .await
        .unwrap();
    assert_eq!(bytes, input);
    assert_eq!(
        fixture.service.active_process("host-real-binary-stdin"),
        None
    );
    let args = ["with spaces", "-leading-option", "literal[1]", "中文"];
    let mut helper_args = vec!["--args"];
    helper_args.extend(args);
    let output = bounded_output(
        &fixture,
        "host-real-argv",
        fixture.helper_args(&helper_args),
        None,
        true,
    )
    .await
    .unwrap();
    assert_eq!(output.code, 0);
    assert_eq!(
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        args
    );
    let output = bounded_output(
        &fixture,
        "host-real-cwd",
        fixture.helper_args(&["--cwd"]),
        None,
        true,
    )
    .await
    .unwrap();
    assert_eq!(output.code, 0);
    assert_eq!(
        fs::canonicalize(String::from_utf8(output.stdout).unwrap().trim()).unwrap(),
        fs::canonicalize(&fixture.path).unwrap()
    );
}

#[tokio::test]
async fn real_ssh_signed_commit_and_annotated_tag_are_valid() {
    let fixture = Fixture::new();
    let (commit, tag) = fixture.signed_objects();
    let raw_commit = fixture.git_bytes(&["cat-file", "commit", &commit], None);
    assert!(String::from_utf8_lossy(&raw_commit).contains("gpgsig -----BEGIN SSH SIGNATURE-----"));
    let raw_tag = fixture.git_bytes(&["cat-file", "tag", &tag], None);
    assert!(String::from_utf8_lossy(&raw_tag).contains("-----BEGIN SSH SIGNATURE-----"));
    for (kind, target, oid) in [
        ("commit", commit.as_str(), commit.as_str()),
        ("tag", "signed-host-tag", tag.as_str()),
    ] {
        let result = fixture
            .verify(kind, target, &format!("host-valid-{kind}"))
            .await
            .unwrap();
        assert_eq!(
            result.status, "valid",
            "actual {kind} crypto output: {}",
            result.output
        );
        assert_eq!(result.oid, oid);
        assert!(
            result.output.contains("ED25519") && result.output.contains("SHA256:"),
            "must come from a real key verifier: {}",
            result.output
        );
        assert_eq!(
            fixture
                .service
                .active_process(&format!("host-valid-{kind}")),
            None
        );
    }
}

#[tokio::test]
async fn real_ssh_verification_distinguishes_missing_signers_and_untrusted_key() {
    let fixture = Fixture::new();
    let (commit, _) = fixture.signed_objects();
    fixture.git(&["config", "--local", "--unset", "gpg.ssh.allowedSignersFile"]);
    let result = fixture
        .verify("commit", &commit, "host-no-allowed-signers-config")
        .await
        .unwrap();
    assert_eq!(
        result.status, "unavailable",
        "actual unconfigured verifier output: {}",
        result.output
    );
    let missing = fixture.home.join("does-not-exist-signers");
    fixture.git(&[
        "config",
        "--local",
        "gpg.ssh.allowedSignersFile",
        missing.to_str().unwrap(),
    ]);
    let result = fixture
        .verify("commit", &commit, "host-missing-allowed-signers-file")
        .await
        .unwrap();
    assert_eq!(
        result.status, "unavailable",
        "actual missing signers output: {}",
        result.output
    );
    // The cryptographic signature stays good, but an unrelated key is the only
    // authorized signer. Generate no persistent keys and trust no user's key.
    let unrelated = fixture.home.join("unrelated-ed25519");
    let keygen = ssh_keygen().unwrap();
    let output = fixture
        .command(&keygen)
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&unrelated)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let public = fs::read_to_string(unrelated.with_extension("pub")).unwrap();
    let allowed = fixture.home.join("untrusted_allowed_signers");
    fs::write(
        &allowed,
        format!("unrelated@example.test {}\n", public.trim()),
    )
    .unwrap();
    fixture.git(&[
        "config",
        "--local",
        "gpg.ssh.allowedSignersFile",
        allowed.to_str().unwrap(),
    ]);
    let result = fixture
        .verify(
            "commit",
            &commit,
            "host-cryptographically-good-untrusted-key",
        )
        .await
        .unwrap();
    assert_eq!(
        result.status, "untrusted",
        "actual untrusted SSH signature output: {}",
        result.output
    );
    let mut untrusted_repo = fixture.repo.clone();
    untrusted_repo.trusted = false;
    let query = VerifyQuery {
        repo_id: untrusted_repo.id.clone(),
        request_id: "host-untrusted-repository".into(),
        kind: "commit".into(),
        target: commit,
    };
    let error = fixture
        .service
        .verify_signature(&untrusted_repo, &query)
        .await
        .unwrap_err();
    assert_eq!(error.code, "UNTRUSTED");
    assert_eq!(fixture.service.active_process(&query.request_id), None);
}

#[tokio::test]
async fn real_ssh_signature_rejects_modified_commit_and_tag_payloads_and_reports_unsigned() {
    let fixture = Fixture::new();
    let (commit, tag) = fixture.signed_objects();
    for (kind, oid, original, replacement) in [
        (
            "commit",
            commit.as_str(),
            "original signed commit payload",
            "tampered signed commit payload",
        ),
        (
            "tag",
            tag.as_str(),
            "original signed tag payload",
            "tampered signed tag payload",
        ),
    ] {
        let raw = fixture.git_bytes(&["cat-file", kind, oid], None);
        let raw = String::from_utf8(raw).unwrap();
        assert_eq!(raw.matches(original).count(), 1);
        let modified = raw.replacen(original, replacement, 1);
        let corrupt_oid = String::from_utf8(fixture.git_bytes(
            &["hash-object", "-w", "-t", kind, "--stdin"],
            Some(modified.as_bytes()),
        ))
        .unwrap()
        .trim()
        .to_owned();
        let target = if kind == "tag" {
            fixture.git(&["update-ref", "refs/tags/tampered-host-tag", &corrupt_oid]);
            "tampered-host-tag"
        } else {
            corrupt_oid.as_str()
        };
        let result = fixture
            .verify(kind, target, &format!("host-tampered-{kind}"))
            .await
            .unwrap();
        assert_eq!(
            result.status, "invalid",
            "actual modified {kind} crypto output: {}",
            result.output
        );
        assert_eq!(result.oid, corrupt_oid);
    }
    fixture.git(&[
        "commit",
        "--quiet",
        "--allow-empty",
        "--no-gpg-sign",
        "--message",
        "unsigned host commit",
    ]);
    let unsigned = fixture.git(&["rev-parse", "HEAD"]);
    fixture.git(&[
        "tag",
        "--annotate",
        "--no-sign",
        "--message",
        "unsigned annotated tag",
        "unsigned-host-tag",
        &unsigned,
    ]);
    for (kind, target) in [("commit", unsigned.as_str()), ("tag", "unsigned-host-tag")] {
        let result = fixture
            .verify(kind, target, &format!("host-unsigned-{kind}"))
            .await
            .unwrap();
        assert_eq!(result.status, "unsigned", "{result:?}");
        assert_eq!(result.output, "This object has no embedded signature.");
    }
}

fn command_environment(command: &Command) -> BTreeMap<String, Option<OsString>> {
    command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().to_ascii_uppercase(),
                value.map(|value| value.to_owned()),
            )
        })
        .collect()
}

#[test]
fn environment_case_normalization_and_allowlist_are_checked_in_a_child_process() {
    if std::env::var_os(ENV_CHILD).as_deref() == Some(std::ffi::OsStr::new("1")) {
        environment_child_assertions();
        return;
    }
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "environment_case_normalization_and_allowlist_are_checked_in_a_child_process",
            "--nocapture",
        ])
        .env(ENV_CHILD, "1")
        .env("gIt_DiR", "forbidden-git-dir")
        .env("Git_Work_Tree", "forbidden-work-tree")
        .env("gIt_CoNfIg_CoUnT", "1")
        .env("Git_Config_Key_0", "core.hooksPath")
        .env("Git_Config_Value_0", "forbidden-hooks")
        .env("Git_AskPass", "allowed-test-askpass")
        .env("Git_Ssh", "allowed-test-ssh")
        .env("Git_Ssh_Command", "allowed-test-ssh-command")
        .env("Git_Ssh_Variant", "ssh")
        .env("Git_Editor", "allowed-test-editor")
        .env("Git_Sequence_Editor", "allowed-test-sequence-editor")
        .env(
            "QGITGRAPH_HOST_ORDINARY",
            "ordinary-variable-is-not-cleared",
        );
    let output = command
        .output()
        .expect("start isolated test harness child, never mutate parallel parent environment");
    assert!(
        output.status.success(),
        "isolated sanitizer assertions failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn environment_child_assertions() {
    let injected = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        "GIT_ASKPASS",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_SSH_VARIANT",
        "GIT_EDITOR",
        "GIT_SEQUENCE_EDITOR",
    ];
    let auth = [
        "GIT_ASKPASS",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_SSH_VARIANT",
    ];
    let editors = ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR"];
    for (trusted, interactive) in [(false, false), (false, true), (true, false), (true, true)] {
        let mut command = Command::new(probe_executable());
        sanitize_environment(&mut command, trusted, interactive, None);
        let environment = command_environment(&command);
        for key in injected {
            let permitted =
                trusted && (auth.contains(&key) || interactive && editors.contains(&key));
            let override_value = environment.get(key).unwrap_or_else(|| {
                panic!("mixed-case inherited {key} was not explicitly sanitized")
            });
            assert_eq!(
                override_value.is_some(),
                permitted,
                "{key}: trusted={trusted}, interactive={interactive}, env={environment:?}"
            );
        }
        assert!(!environment.contains_key("QGITGRAPH_HOST_ORDINARY"));
    }
    let home = tempfile::Builder::new()
        .prefix("qgitgraph-host-env-")
        .tempdir()
        .unwrap();
    let mut command = Command::new(probe_executable());
    sanitize_environment(&mut command, true, true, Some(home.path()));
    let environment = command_environment(&command);
    for key in injected {
        assert_eq!(
            environment.get(key),
            Some(&None),
            "isolated HOME must disable inherited helper/editor/routing variable {key}"
        );
    }
    assert_eq!(
        environment.get("HOME"),
        Some(&Some(home.path().as_os_str().to_owned()))
    );
    assert_eq!(
        environment.get("USERPROFILE"),
        Some(&Some(home.path().as_os_str().to_owned()))
    );
    assert_eq!(
        environment.get("GIT_CONFIG_NOSYSTEM"),
        Some(&Some(OsString::from("1")))
    );
    assert_eq!(
        environment.get("GIT_CONFIG_GLOBAL"),
        Some(&Some(home.path().join(".gitconfig").into_os_string()))
    );
    command.arg("--checkenv").args([
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_CONFIG_COUNT",
        "GIT_ASKPASS",
        "GIT_SSH_COMMAND",
        "GIT_EDITOR",
        "HOME",
        "GIT_CONFIG_NOSYSTEM",
        "QGITGRAPH_HOST_ORDINARY",
    ]);
    let output = command.output().unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_CONFIG_COUNT",
        "GIT_ASKPASS",
        "GIT_SSH_COMMAND",
        "GIT_EDITOR",
    ] {
        assert!(
            text.lines().any(|line| line == format!("{key}=<absent>")),
            "actual probe inherited forbidden variable: {text}"
        );
    }
    assert!(text.contains("GIT_CONFIG_NOSYSTEM=1"));
    assert!(text.contains("QGITGRAPH_HOST_ORDINARY=ordinary-variable-is-not-cleared"));
}
