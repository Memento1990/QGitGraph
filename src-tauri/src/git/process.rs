use crate::{
    error::{AppError, Result},
    performance::Span,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct ProcessTree {
    inner: Arc<Inner>,
}

struct Inner {
    #[cfg(windows)]
    handle: isize,
}

#[cfg(windows)]
impl Drop for Inner {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

impl ProcessTree {
    pub fn new() -> Result<Self> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(AppError::io(std::io::Error::last_os_error()));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return Err(AppError::io(std::io::Error::last_os_error()));
            }
            Ok(Self {
                inner: Arc::new(Inner {
                    handle: handle as isize,
                }),
            })
        }
        #[cfg(not(windows))]
        Ok(Self {
            inner: Arc::new(Inner {}),
        })
    }

    pub fn attach_and_resume(&self, pid: u32, request_id: &str, verb: &'static str) -> Result<()> {
        let mut job_span = Span::begin(request_id, "job-attach", verb);
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Foundation::*;
            use windows_sys::Win32::System::{
                Diagnostics::ToolHelp::*, JobObjects::*, Threading::*,
            };
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if process.is_null() {
                return Err(AppError::io(std::io::Error::last_os_error()));
            }
            let assigned = AssignProcessToJobObject(self.inner.handle as _, process);
            CloseHandle(process);
            if assigned == 0 {
                return Err(AppError::io(std::io::Error::last_os_error()));
            }
            job_span.complete();
            drop(job_span);
            let mut resume_span = Span::begin(request_id, "resume", verb);
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(AppError::io(std::io::Error::last_os_error()));
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut found = false;
            if Thread32First(snapshot, &mut entry) != 0 {
                loop {
                    if entry.th32OwnerProcessID == pid {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if !thread.is_null() {
                            let resumed = ResumeThread(thread);
                            CloseHandle(thread);
                            if resumed != u32::MAX {
                                found = true;
                                break;
                            }
                        }
                    }
                    if Thread32Next(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
            if !found {
                return Err(AppError::new(
                    "PROCESS",
                    "Could not resume the isolated Git process.",
                ));
            }
            resume_span.complete();
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            job_span.complete();
            drop(job_span);
            let mut resume_span = Span::begin(request_id, "resume", verb);
            resume_span.complete();
        }
        Ok(())
    }

    pub fn terminate(&self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.inner.handle as _, 1);
        }
    }
}
