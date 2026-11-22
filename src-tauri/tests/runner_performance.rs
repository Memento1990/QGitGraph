//! Runner regressions use only isolated TempDir repositories and build-only
//! helpers. No user repository, global Git config, shell command or network.

use qgitgraph_lib::{git::GitService, model::Repository};
use std::{fs, path::PathBuf};
use tempfile::TempDir;

struct Fixture {
    directory: TempDir,
    service: GitService,
    repo: Repository,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("qgitgraph-runner-performance-")
            .tempdir()
            .unwrap();
        let home = directory.path().join("isolated home");
        let path = directory.path().join("repository with spaces 中文");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home);
        let repo = Repository {
            id: "runner-performance-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            name: "runner fixture".into(),
            git_dir: path.join(".git").to_string_lossy().into_owned(),
            common_dir: path.join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: true,
            bare: false,
        };
        service
            .run(
                &repo,
                "initialize-runner-fixture",
                ["init", "--quiet", "--initial-branch=main", "--template="]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                false,
            )
            .await
            .unwrap();
        Self {
            directory,
            service,
            repo,
        }
    }
}

#[tokio::test]
async fn cached_version_preserves_output_and_never_bypasses_cancellation() {
    let fixture = Fixture::new().await;
    let direct = fixture
        .service
        .run(
            &fixture.repo,
            "direct-version",
            vec!["--version".into()],
            false,
        )
        .await
        .unwrap();
    let cold = fixture
        .service
        .version(&fixture.repo, "cold-version")
        .await
        .unwrap();
    fixture
        .service
        .set_git_path(fixture.service.git_path().to_str().unwrap())
        .unwrap();
    let warm = fixture
        .service
        .version(&fixture.repo, "warm-version")
        .await
        .unwrap();
    assert_eq!(direct, cold);
    assert_eq!(warm, cold);
    assert!(fixture.service.active_processes("warm-version").is_empty());
    fixture.service.cancel("pre-cancelled-warm-version");
    assert!(fixture
        .service
        .request_cancelled("pre-cancelled-warm-version"));
    assert_eq!(
        fixture
            .service
            .version(&fixture.repo, "pre-cancelled-warm-version")
            .await
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert!(!fixture
        .service
        .request_cancelled("pre-cancelled-warm-version"));
    assert_eq!(
        fixture
            .service
            .version(&fixture.repo, "pre-cancelled-warm-version")
            .await
            .unwrap(),
        cold
    );
    let guard = fixture
        .service
        .begin_request("cancelled-warm-version")
        .unwrap();
    fixture.service.cancel("cancelled-warm-version");
    assert_eq!(
        fixture
            .service
            .version(&fixture.repo, "cancelled-warm-version")
            .await
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert!(fixture
        .service
        .active_processes("cancelled-warm-version")
        .is_empty());
    drop(guard);
    assert!(fixture
        .service
        .check_request("cancelled-warm-version")
        .is_ok());
}

#[tokio::test]
async fn combined_discovery_returns_three_absolute_records_for_linked_worktrees() {
    let fixture = Fixture::new().await;
    let linked = fixture.directory.path().join("linked worktree 中文");
    // Seed a commit and use detached worktree add on every supported Git.
    let commit = fixture
        .service
        .run(
            &fixture.repo,
            "seed-worktree",
            vec![
                "-c".into(),
                "user.name=Runner fixture".into(),
                "-c".into(),
                "user.email=runner@example.test".into(),
                "-c".into(),
                "commit.gpgsign=false".into(),
                "commit".into(),
                "--quiet".into(),
                "--allow-empty".into(),
                "--no-verify".into(),
                "--message=fixture root".into(),
            ],
            false,
        )
        .await;
    commit.unwrap();
    fixture
        .service
        .run(
            &fixture.repo,
            "add-worktree",
            vec![
                "worktree".into(),
                "add".into(),
                "--detach".into(),
                linked.to_string_lossy().into_owned(),
                "HEAD".into(),
            ],
            false,
        )
        .await
        .unwrap();
    let mut repo = fixture.repo.clone();
    repo.path = linked.to_string_lossy().into_owned();
    let output = fixture
        .service
        .run(
            &repo,
            "combined-discovery",
            [
                "rev-parse",
                "--path-format=absolute",
                "--absolute-git-dir",
                "--git-common-dir",
                "--is-bare-repository",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            false,
        )
        .await
        .unwrap();
    let lines: Vec<_> = output.lines().collect();
    assert_eq!(lines.len(), 3);
    assert!(PathBuf::from(lines[0]).is_absolute());
    assert!(PathBuf::from(lines[1]).is_absolute());
    assert_eq!(lines[2], "false");
    assert_ne!(
        fs::canonicalize(lines[0]).unwrap(),
        fs::canonicalize(lines[1]).unwrap()
    );
    assert_eq!(
        fs::canonicalize(lines[1]).unwrap(),
        fs::canonicalize(&fixture.repo.common_dir).unwrap()
    );
}

#[cfg(all(windows, feature = "host-tests"))]
mod windows_parallel {
    use super::*;
    use qgitgraph_lib::{error::Result, git::ProcessOutput};
    use std::{
        path::Path,
        time::{Duration, Instant},
    };
    use tokio::task::JoinHandle;

    struct Probe {
        directory: PathBuf,
        task: JoinHandle<Result<ProcessOutput>>,
    }

    fn is_alive(pid: u32) -> bool {
        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
                WAIT_TIMEOUT,
            },
            System::Threading::{
                OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SYNCHRONIZE,
            },
        };
        unsafe {
            let handle = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            if handle.is_null() {
                let error = GetLastError();
                assert!(matches!(
                    error,
                    ERROR_INVALID_PARAMETER | ERROR_ACCESS_DENIED
                ));
                return error == ERROR_ACCESS_DENIED;
            }
            let waiting = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
            CloseHandle(handle);
            waiting
        }
    }

    struct Cleanup {
        service: GitService,
        request: String,
        directories: Vec<PathBuf>,
    }

    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.service.cancel(&self.request);
            let mut pids = self.service.active_processes(&self.request);
            for directory in &self.directories {
                for role in ["probe", "child", "grandchild"] {
                    if let Ok(value) = fs::read_to_string(directory.join(format!("{role}.pid"))) {
                        if let Ok(pid) = value.trim().parse() {
                            pids.push(pid);
                        }
                    }
                }
            }
            unsafe {
                use windows_sys::Win32::{
                    Foundation::CloseHandle,
                    System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
                };
                for pid in pids {
                    let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
                    if !handle.is_null() {
                        TerminateProcess(handle, 99);
                        CloseHandle(handle);
                    }
                }
            }
        }
    }

    fn install_probe(fixture: &Fixture) -> PathBuf {
        let directory = fixture.directory.path().join("test helper executable");
        fs::create_dir(&directory).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_qgitgraph-test-probe"),
            directory.join("git-qgitgraph-runner-probe.exe"),
        )
        .unwrap();
        directory
    }

    fn spawn_probe(fixture: &Fixture, helper: &Path, request: &str, index: usize) -> Probe {
        let directory = fixture.directory.path().join(format!("probe-{index}"));
        fs::create_dir(&directory).unwrap();
        let service = fixture.service.clone();
        let repo = fixture.repo.clone();
        let id = request.to_owned();
        let args = vec![
            format!("--exec-path={}", helper.display()),
            "qgitgraph-runner-probe".into(),
            "--emit-tree".into(),
            directory.to_string_lossy().into_owned(),
            "stdout".into(),
            "1".into(),
        ];
        let task =
            tokio::spawn(async move { service.run_output(&repo, &id, args, None, false).await });
        Probe { directory, task }
    }

    async fn wait_ready(directory: &Path) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !directory.join("ready").is_file() {
            assert!(Instant::now() < deadline, "test probe did not become ready");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn assert_gone(pids: &[u32]) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let live: Vec<_> = pids.iter().copied().filter(|pid| is_alive(*pid)).collect();
            if live.is_empty() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "runner left live fixture processes {live:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn finishing_one_parallel_child_preserves_other_observer_and_cancel_reaps_tree() {
        let fixture = Fixture::new().await;
        let request = "runner-parallel-reap";
        let guard = fixture.service.begin_request(request).unwrap();
        let helper = install_probe(&fixture);
        let first = spawn_probe(&fixture, &helper, request, 0);
        let second = spawn_probe(&fixture, &helper, request, 1);
        let mut cleanup = Cleanup {
            service: fixture.service.clone(),
            request: request.into(),
            directories: vec![first.directory.clone(), second.directory.clone()],
        };
        wait_ready(&first.directory).await;
        wait_ready(&second.directory).await;
        let roots = fixture.service.active_processes(request);
        assert_eq!(roots.len(), 2);
        assert!(roots.iter().all(|pid| is_alive(*pid)));
        assert_eq!(
            fixture.service.active_process(request),
            roots.first().copied()
        );
        let mut pids = roots.clone();
        for directory in &cleanup.directories {
            for role in ["probe", "child", "grandchild"] {
                let pid: u32 = fs::read_to_string(directory.join(format!("{role}.pid")))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                assert!(is_alive(pid));
                pids.push(pid);
            }
        }
        fs::write(first.directory.join("release"), b"finish first only").unwrap();
        let output = tokio::time::timeout(Duration::from_secs(10), first.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(output.code, 0);
        let remaining = fixture.service.active_processes(request);
        assert_eq!(remaining.len(), 1);
        assert!(roots.contains(&remaining[0]));
        assert!(is_alive(remaining[0]));
        fixture.service.cancel(request);
        let error = tokio::time::timeout(Duration::from_secs(10), second.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "CANCELLED");
        assert!(fixture.service.active_processes(request).is_empty());
        assert_gone(&pids).await;
        drop(guard);
        cleanup.directories.clear();
        assert!(fixture
            .service
            .run(&fixture.repo, request, vec!["--version".into()], false)
            .await
            .unwrap()
            .starts_with("git version "));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_request_obeys_six_global_slots_and_cancel_never_spawns_queued_children() {
        let fixture = Fixture::new().await;
        let request = "runner-six-slots";
        let guard = fixture.service.begin_request(request).unwrap();
        let helper = install_probe(&fixture);
        let mut cleanup = Cleanup {
            service: fixture.service.clone(),
            request: request.into(),
            directories: Vec::new(),
        };
        let mut probes = Vec::new();
        // Fill all slots before creating the two queued children, so the latter
        // can be proven never to have executed rather than sampled in a race.
        for index in 0..6 {
            let probe = spawn_probe(&fixture, &helper, request, index);
            cleanup.directories.push(probe.directory.clone());
            wait_ready(&probe.directory).await;
            probes.push(probe);
        }
        assert_eq!(fixture.service.active_processes(request).len(), 6);
        for index in 6..8 {
            let probe = spawn_probe(&fixture, &helper, request, index);
            cleanup.directories.push(probe.directory.clone());
            probes.push(probe);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fixture.service.active_processes(request).len(), 6);
        assert!(!probes[6].directory.join("probe.pid").exists());
        assert!(!probes[7].directory.join("probe.pid").exists());
        let mut pids = fixture.service.active_processes(request);
        for probe in probes.iter().take(6) {
            for role in ["probe", "child", "grandchild"] {
                pids.push(
                    fs::read_to_string(probe.directory.join(format!("{role}.pid")))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap(),
                );
            }
        }
        fixture.service.cancel(request);
        for probe in probes {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(10), probe.task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err()
                    .code,
                "CANCELLED"
            );
        }
        assert!(fixture.service.active_processes(request).is_empty());
        assert!(!cleanup.directories[6].join("probe.pid").exists());
        assert!(!cleanup.directories[7].join("probe.pid").exists());
        assert_gone(&pids).await;
        drop(guard);
        cleanup.directories.clear();
    }
}
