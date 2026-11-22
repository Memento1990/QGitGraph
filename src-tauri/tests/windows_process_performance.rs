//! Windows-native launcher regressions through GitService's real public path.
//! Requires parent integration of windows_process and --features host-tests.
//! Only temporary directories, installed Git, and our build-only probe are used.
#![cfg(all(windows, feature = "host-tests"))]

use qgitgraph_lib::{git::GitService, model::Repository};
use std::{fs, path::PathBuf, time::Instant};
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    service: GitService,
    repo: Repository,
    home: PathBuf,
    helper: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-native-process-")
            .tempdir()
            .unwrap();
        let home = directory.path().join("isolated home 中文");
        let cwd = directory.path().join("working directory 中文 & spaces");
        let helper = directory.path().join("exec path 中文 & spaces");
        for path in [&home, &cwd, &helper] {
            fs::create_dir(path).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_qgitgraph-test-probe"),
            helper.join("git-qgitgraph-native-probe.exe"),
        )
        .unwrap();
        Self {
            service: GitService::isolated(None, home.clone()),
            repo: Repository {
                id: "native-process-fixture".into(),
                path: cwd.to_str().unwrap().to_owned(),
                name: "native launcher fixture".into(),
                git_dir: String::new(),
                common_dir: String::new(),
                head: None,
                branch: None,
                trusted: false,
                bare: false,
            },
            _directory: directory,
            home,
            helper,
        }
    }
    fn arguments(&self, mode: &str) -> Vec<String> {
        vec![
            format!("--exec-path={}", self.helper.display()),
            "qgitgraph-native-probe".into(),
            mode.into(),
        ]
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_launch_preserves_crt_arguments_unicode_cwd_and_isolated_environment() {
    let fixture = Fixture::new();
    let expected = [
        "",
        "plain",
        "two words",
        "tab\tinside",
        "中文 Ω 😀",
        "a\"b",
        "\"",
        "\\\"",
        "\\\\\\\"",
        "tail\\",
        "two\\\\",
        "space with trailing \\",
        "C:\\folder with spaces\\",
        "& | < > ^ %PATH% !value! ` $(not-a-shell)",
        "--leading-option=value",
    ];
    let mut args = fixture.arguments("--args");
    args.extend(expected.iter().map(|value| (*value).to_owned()));
    let output = fixture
        .service
        .run_output(&fixture.repo, "native-crt-arguments", args, None, false)
        .await
        .unwrap();
    assert_eq!(output.code, 0, "{:?}", output.stderr);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        expected
            .iter()
            .map(|value| format!("{value}\n"))
            .collect::<String>()
    );
    let cwd = fixture
        .service
        .run(
            &fixture.repo,
            "native-unicode-cwd",
            fixture.arguments("--cwd"),
            false,
        )
        .await
        .unwrap();
    assert_eq!(
        fs::canonicalize(cwd.trim_end()).unwrap(),
        fs::canonicalize(&fixture.repo.path).unwrap()
    );
    let mut args = fixture.arguments("--checkenv");
    args.extend(
        [
            "HOME",
            "USERPROFILE",
            "XDG_CONFIG_HOME",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_CONFIG_GLOBAL",
            "GIT_TERMINAL_PROMPT",
            "GIT_OPTIONAL_LOCKS",
            "GIT_LITERAL_PATHSPECS",
            "GIT_EDITOR",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    let environment = fixture
        .service
        .run(&fixture.repo, "native-isolated-environment", args, false)
        .await
        .unwrap();
    for expected in [
        format!("HOME={}", fixture.home.display()),
        format!("USERPROFILE={}", fixture.home.display()),
        format!("XDG_CONFIG_HOME={}", fixture.home.join(".config").display()),
        format!(
            "GIT_CONFIG_GLOBAL={}",
            fixture.home.join(".gitconfig").display()
        ),
        "GIT_CONFIG_NOSYSTEM=1".into(),
        "GIT_TERMINAL_PROMPT=0".into(),
        "GIT_OPTIONAL_LOCKS=0".into(),
        "GIT_LITERAL_PATHSPECS=1".into(),
        "GIT_EDITOR=true".into(),
    ] {
        assert!(
            environment.lines().any(|line| line == expected),
            "{expected}: {environment}"
        );
    }
    assert!(fixture
        .service
        .active_processes("native-crt-arguments")
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_pipes_round_trip_eight_mib_and_preserve_nonzero_exit_with_broken_stdin() {
    let fixture = Fixture::new();
    let input: Vec<u8> = (0..8 * 1024 * 1024).map(|index| index as u8).collect();
    let output = fixture
        .service
        .run_output(
            &fixture.repo,
            "native-binary-stdin",
            fixture.arguments("--echo-input"),
            Some(input.clone()),
            false,
        )
        .await
        .unwrap();
    assert_eq!(output.code, 0, "{:?}", output.stderr);
    assert_eq!(output.stdout, input);
    assert!(output.stderr.is_empty());
    // This probe exits 2 without reading stdin. An expected EPIPE must not turn
    // its nonzero ProcessOutput into a generic IO error or successful partial data.
    let output = fixture
        .service
        .run_output(
            &fixture.repo,
            "native-nonzero-stdin",
            fixture.arguments("--unknown-probe-mode"),
            Some(input),
            false,
        )
        .await
        .unwrap();
    assert_eq!(output.code, 2);
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown test-probe mode"));
    assert!(fixture
        .service
        .active_processes("native-binary-stdin")
        .is_empty());
    assert!(fixture
        .service
        .active_processes("native-nonzero-stdin")
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_no_input_is_eof_and_nul_is_rejected_before_spawn() {
    let fixture = Fixture::new();
    let output = fixture
        .service
        .run_output(
            &fixture.repo,
            "native-stdin-eof",
            fixture.arguments("--echo-input"),
            None,
            false,
        )
        .await
        .unwrap();
    assert_eq!(output.code, 0);
    assert!(output.stdout.is_empty());
    let mut args = fixture.arguments("--args");
    args.push("not\0an-argument".into());
    let error = fixture
        .service
        .run_output(&fixture.repo, "native-nul-argument", args, None, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, "ARGUMENT");
    assert!(fixture
        .service
        .active_processes("native-nul-argument")
        .is_empty());
}

/// Deliberately no timing assertion: antivirus, host load and cold image mapping
/// dominate individual Windows samples. Call run_output, never the version cache.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opt-in warm native launcher measurement, not a wall-clock CI assertion"]
async fn measure_uncached_windows_native_launches() {
    let fixture = Fixture::new();
    let mut samples = Vec::new();
    for index in 0..35 {
        let started = Instant::now();
        let output = fixture
            .service
            .run_output(
                &fixture.repo,
                &format!("native-measure-{index}"),
                vec!["--version".into()],
                None,
                false,
            )
            .await
            .unwrap();
        assert_eq!(output.code, 0);
        assert!(output.stdout.starts_with(b"git version "));
        if index >= 5 {
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    samples.sort_by(f64::total_cmp);
    eprintln!(
        "uncached Windows GitService native launch: n={}, p50={:.3} ms, p95={:.3} ms, max={:.3} ms",
        samples.len(),
        samples[samples.len() / 2],
        samples[28],
        samples[samples.len() - 1],
    );
}
