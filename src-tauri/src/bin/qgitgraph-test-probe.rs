//! Build-only, deterministic host-test helper. It does not open sockets, execute
//! a shell, read user configuration, or run arbitrary executables. Descendants
//! can only be another copy of this executable. Never expose this as an IPC API
//! or include it in the desktop application's distribution.

use std::{
    env,
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{self, Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const LIFETIME: Duration = Duration::from_secs(90);

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn argument(args: &[OsString], index: usize) -> io::Result<&std::ffi::OsStr> {
    args.get(index)
        .map(OsString::as_os_str)
        .ok_or_else(|| invalid("missing explicit test-probe argument"))
}

fn number(args: &[OsString], index: usize) -> io::Result<usize> {
    argument(args, index)?
        .to_str()
        .ok_or_else(|| invalid("non-UTF-8 number"))?
        .parse()
        .map_err(|_| invalid("invalid numeric test-probe argument"))
}

fn record_pid(directory: &Path, role: &str) -> io::Result<()> {
    // Rename a fully written file so that the test never reads a partial PID.
    let pending = directory.join(format!("{role}.pending"));
    fs::write(&pending, format!("{}\n", process::id()))?;
    fs::rename(pending, directory.join(format!("{role}.pid")))
}

fn wait_for_file(path: &Path, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    while !path.is_file() {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("test probe did not see {}", path.display()),
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn descendant(directory: &Path, depth: usize) -> io::Result<Child> {
    let mut command = Command::new(env::current_exe()?);
    command
        .arg("--descendant")
        .arg(directory)
        .arg(depth.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn()
}

fn sleep_until_deadline() {
    thread::sleep(LIFETIME);
}

fn emit(stream: &str, count: usize) -> io::Result<()> {
    if count > 40 * 1024 * 1024 {
        return Err(invalid("probe output is deliberately capped at 40 MiB"));
    }
    let mut output: Box<dyn Write> = match stream {
        "stdout" => Box::new(io::stdout().lock()),
        "stderr" => Box::new(io::stderr().lock()),
        _ => return Err(invalid("expected stdout or stderr")),
    };
    let bytes = [b'Q'; 32768];
    let mut remaining = count;
    while remaining != 0 {
        let size = remaining.min(bytes.len());
        output.write_all(&bytes[..size])?;
        remaining -= size;
    }
    output.flush()
}

fn main_result() -> io::Result<()> {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let mode = argument(&args, 0)?;
    if mode == "--descendant" {
        let directory = PathBuf::from(argument(&args, 1)?);
        let depth = number(&args, 2)?;
        if depth > 1 {
            return Err(invalid("probe descendants are limited to two levels"));
        }
        let role = if depth == 1 { "child" } else { "grandchild" };
        record_pid(&directory, role)?;
        let mut child = if depth == 1 {
            Some(descendant(&directory, 0)?)
        } else {
            None
        };
        sleep_until_deadline();
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Ok(());
    }
    if mode == "--tree" {
        // Any following SSH arguments are only logged, never interpreted. Git
        // runs this explicit helper instead of a real SSH/network executable.
        let directory = PathBuf::from(argument(&args, 1)?);
        record_pid(&directory, "probe")?;
        fs::write(directory.join("arguments.txt"), format!("{args:?}\n"))?;
        fs::write(
            directory.join("cwd.txt"),
            env::current_dir()?.to_string_lossy().as_bytes(),
        )?;
        let mut child = descendant(&directory, 1)?;
        wait_for_file(&directory.join("grandchild.pid"), Duration::from_secs(15))?;
        fs::write(directory.join("ready"), b"all three probes started\n")?;
        sleep_until_deadline();
        let _ = child.kill();
        let _ = child.wait();
        return Ok(());
    }
    if mode == "--emit-tree" {
        let directory = PathBuf::from(argument(&args, 1)?);
        let stream = argument(&args, 2)?
            .to_str()
            .ok_or_else(|| invalid("invalid stream"))?;
        let count = number(&args, 3)?;
        record_pid(&directory, "probe")?;
        let mut child = descendant(&directory, 1)?;
        wait_for_file(&directory.join("grandchild.pid"), Duration::from_secs(15))?;
        fs::write(directory.join("ready"), b"all three probes started\n")?;
        // Parent test must first observe every live process, then release output.
        wait_for_file(&directory.join("release"), Duration::from_secs(20))?;
        let result = emit(stream, count);
        let _ = child.kill();
        let _ = child.wait();
        return result;
    }
    if mode == "--emit" {
        let stream = argument(&args, 1)?
            .to_str()
            .ok_or_else(|| invalid("invalid stream"))?;
        return emit(stream, number(&args, 2)?);
    }
    if mode == "--echo-input" {
        let mut bytes = Vec::new();
        io::stdin()
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        io::stdout().write_all(&bytes)?;
        return Ok(());
    }
    if mode == "--cwd" {
        println!("{}", env::current_dir()?.display());
        return Ok(());
    }
    if mode == "--args" {
        for value in args.iter().skip(1) {
            println!("{}", value.to_string_lossy());
        }
        return Ok(());
    }
    if mode == "--checkenv" {
        for key in args.iter().skip(1) {
            println!(
                "{}={}",
                key.to_string_lossy(),
                env::var_os(key)
                    .map(|v| v.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "<absent>".into())
            );
        }
        return Ok(());
    }
    Err(invalid("unknown test-probe mode"))
}

fn main() {
    if let Err(error) = main_result() {
        eprintln!("qgitgraph test probe: {error}");
        process::exit(2);
    }
}
