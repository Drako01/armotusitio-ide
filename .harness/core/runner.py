"""Bounded subprocesses with sanitized local evidence and process-tree cancellation."""
import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from .config import ROOT, H, policy, task_id, root
from .security import command_policy, redact


def windows_spec(cmd, args):
    if os.name == 'nt' and cmd == 'bash':
        candidates = [os.environ.get('HARNESS_BASH', ''), str(Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Git/bin/bash.exe')]
        found = next((p for p in candidates if p and Path(p).is_file()), None)
        if not found:
            raise ValueError('Windows Harness requires Git Bash; set HARNESS_BASH to its bash.exe path')
        return found, args
    if os.name != 'nt' or Path(cmd).suffix.lower() not in ['', '.cmd', '.bat']:
        return cmd, args
    resolved = shutil.which(cmd)
    if resolved and Path(resolved).suffix.lower() in ['.cmd', '.bat']:
        quote = lambda s: "'" + s.replace("'", "''") + "'"
        # Powershell performs literal argument quoting; task text is never interpolated here.
        rendered = ' '.join(quote(a.replace('"', '\\"') if a.startswith('{') else a) for a in args)
        ps = str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
        return ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                    "$ErrorActionPreference='Stop'; & " + quote(resolved) + ' ' + rendered + '; exit $LASTEXITCODE']
    return cmd, args


class WindowsJob:
    """Own a non-inheritable, kill-on-close job before the child can execute."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes as w
        self.ctypes = ctypes
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        self.handle = None

        class BasicLimits(ctypes.Structure):
            _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64),
                        ('LimitFlags', w.DWORD), ('MinimumWorkingSet', ctypes.c_size_t),
                        ('MaximumWorkingSet', ctypes.c_size_t), ('ActiveProcessLimit', w.DWORD),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [('Basic', BasicLimits), ('IoCounters', ctypes.c_uint64 * 6),
                        ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                        ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

        class ThreadEntry(ctypes.Structure):
            _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ThreadID', w.DWORD),
                        ('th32OwnerProcessID', w.DWORD), ('tpBasePri', w.LONG),
                        ('tpDeltaPri', w.LONG), ('dwFlags', w.DWORD)]

        self.ThreadEntry = ThreadEntry
        signatures = {
            'CreateJobObjectW': ([ctypes.c_void_p, w.LPCWSTR], w.HANDLE),
            'SetInformationJobObject': ([w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD], w.BOOL),
            'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
            'CloseHandle': ([w.HANDLE], w.BOOL),
            'CreateToolhelp32Snapshot': ([w.DWORD, w.DWORD], w.HANDLE),
            'Thread32First': ([w.HANDLE, ctypes.POINTER(ThreadEntry)], w.BOOL),
            'Thread32Next': ([w.HANDLE, ctypes.POINTER(ThreadEntry)], w.BOOL),
            'OpenThread': ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            'ResumeThread': ([w.HANDLE], w.DWORD),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = args, result
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def attach_and_resume(self, process):
        c, api = self.ctypes, self.api
        if not api.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise c.WinError(c.get_last_error())
        # Popen closes the primary thread handle. Recover it from a finite snapshot;
        # CREATE_SUSPENDED guarantees that user code has not spawned other threads/children.
        snapshot = api.CreateToolhelp32Snapshot(4, 0)  # TH32CS_SNAPTHREAD
        if snapshot == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
        try:
            entry = self.ThreadEntry()
            entry.dwSize = c.sizeof(entry)
            found = api.Thread32First(snapshot, c.byref(entry))
            while found:
                if entry.th32OwnerProcessID == process.pid:
                    thread = api.OpenThread(2, False, entry.th32ThreadID)  # THREAD_SUSPEND_RESUME
                    if not thread:
                        raise c.WinError(c.get_last_error())
                    try:
                        if api.ResumeThread(thread) != 1:
                            raise OSError('Cannot resume suspended Harness process')
                    finally:
                        api.CloseHandle(thread)
                    return
                found = api.Thread32Next(snapshot, c.byref(entry))
            raise OSError('Cannot find suspended Harness process thread')
        finally:
            api.CloseHandle(snapshot)

    def close(self):
        if self.handle:
            if not self.api.CloseHandle(self.handle):
                raise self.ctypes.WinError(self.ctypes.get_last_error())
            self.handle = None


def kill_tree(process, job=None):
    if job is not None:
        job.close()  # Kernel terminates every descendant, even if the parent already exited.
        return
    if os.name == 'nt':
        raise RuntimeError('Windows Harness process requires an owned job')
    # Collect descendants first: children that started their own session survive killpg but still hang off the parent chain.
    relatives = descendants(process.pid)
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
    for pid in relatives:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def process_table():
    """{pid: ppid} for every visible process (POSIX). /proc where available, `ps` otherwise; {} when neither works."""
    proc = Path('/proc')
    if (proc / 'self' / 'stat').exists():
        table = {}
        for entry in proc.iterdir():
            if entry.name.isdigit():
                try:
                    table[int(entry.name)] = int((entry / 'stat').read_text().rsplit(')', 1)[1].split()[1])
                except (OSError, IndexError, ValueError):
                    pass  # the process exited while we were reading the table
        return table
    try:
        listing = subprocess.run(['ps', '-A', '-o', 'pid=', '-o', 'ppid='], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5).stdout.decode()
    except (OSError, subprocess.SubprocessError):
        return {}
    return {int(a): int(b) for a, b in (line.split() for line in listing.splitlines() if len(line.split()) == 2) if a.isdigit() and b.isdigit()}


def descendants(pid):
    """Pids below `pid` in the process table. Best effort: children that opened their own session survive killpg."""
    children = {}
    for child, parent in process_table().items():
        children.setdefault(parent, []).append(child)
    found, stack = [], [pid]
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


def spawn_run(cmd, args, options=None):
    options = options or {}
    command_policy(cmd, args, trusted=options.get('trusted', False))
    if options.get('raw') and options.get('persist', True):
        raise ValueError('Unredacted runner output is in-memory only: raw requires persist=False')
    started = time.monotonic()
    timeout = options.get('timeoutMs', 600000)
    limit = options.get('outputLimitBytes', policy()['outputLimitBytes'])
    tail = options.get('tailBytes', policy()['tailBytes'])
    if not isinstance(timeout, int) or not 0 <= timeout <= 86400000 or not isinstance(limit, int) or limit < 1:
        raise ValueError('Invalid runner timeout/output limit')
    cmd, args = windows_spec(cmd, args)
    environment = {**os.environ, **(options.get('env') or {})}
    environment.pop('HARNESS_RESULT_FILE', None) if options.get('host') == 'claude' else None
    out, err = bytearray(), bytearray()
    overflow = threading.Event()
    total = [0]
    mutex = threading.Lock()
    job, process = None, None
    try:
        invocation = [cmd, *args]
        if os.name == 'nt' and Path(cmd).name.lower() == 'cmd.exe' and args[:3] == ['/d', '/s', '/c'] and len(args) == 4:
            # Explicit trusted custom-command adapter. list2cmdline cannot encode cmd's /s nested quoting.
            invocation = subprocess.list2cmdline([cmd]) + ' /d /s /c "' + args[3] + '"'
        job = WindowsJob() if os.name == 'nt' else None
        process = subprocess.Popen(invocation, cwd=root(ROOT), env=environment, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=os.name != 'nt',
                                   creationflags=0x4 if job else 0)  # CREATE_SUSPENDED
        if job:
            job.attach_and_resume(process)
        if options.get('onSpawn'):
            options['onSpawn'](process.pid)
    except BaseException as error:
        try:
            if process is not None:
                # Setup failures occur before user code runs: kill the suspended parent.
                process.kill()
                process.wait(timeout=1)
        finally:
            if job:
                job.close()
            if process is not None:
                for pipe in (process.stdin, process.stdout, process.stderr):
                    pipe.close()
        if not isinstance(error, OSError):
            raise
        return {'code': 127, 'out': '', 'err': redact(str(error)), 'durationMs': round((time.monotonic() - started) * 1000)}

    def drain(pipe, target):
        while True:
            block = pipe.read(8192)
            if not block:
                break
            with mutex:
                remaining = max(0, limit - total[0])
                target.extend(block[:remaining])
                total[0] += len(block)
                if total[0] > limit:
                    overflow.set()
        pipe.close()

    threads = [threading.Thread(target=drain, args=(process.stdout, out), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, err), daemon=True)]
    for thread in threads:
        thread.start()

    def feed():
        try:
            if options.get('input') is not None:
                process.stdin.write(options['input'].encode('utf-8'))
        except (BrokenPipeError, OSError):
            pass
        finally:
            process.stdin.close()

    feeder = threading.Thread(target=feed, daemon=True)
    feeder.start()
    code = None
    cancel = options.get('cancel')
    try:
        while process.poll() is None:
            if cancel is not None and cancel.is_set():
                kill_tree(process, job)  # cooperative cancellation: the whole process tree dies, never only the parent
                code = 130
                break
            if overflow.is_set():
                kill_tree(process, job)
                code = 125
                break
            if timeout and (time.monotonic() - started) * 1000 >= timeout:
                kill_tree(process, job)
                code = 124
                break
            time.sleep(.01)
        process.wait(timeout=1 if job else 10)
    except subprocess.TimeoutExpired as error:
        kill_tree(process, job)
        reason = f'Harness timeout after {timeout}ms' if code == 124 else 'Harness output size limit exceeded' if code == 125 else 'Harness cancellation' if code == 130 else 'Harness process exit'
        # Job termination is asynchronous. A bounded cleanup failure must stay
        # fail-closed without erasing the cancellation reason (or echoing argv).
        raise RuntimeError(reason + '; process-tree cleanup timed out') from error
    except BaseException:
        kill_tree(process, job)
        raise
    finally:
        if job:
            job.close()
    drain_deadline = time.monotonic() + 1
    for thread in threads:
        thread.join(timeout=max(0, drain_deadline - time.monotonic()) if job else 10)
    if job and any(thread.is_alive() for thread in threads):
        reason = f'Harness timeout after {timeout}ms; ' if code == 124 else 'Harness output size limit exceeded; ' if code == 125 else ''
        raise RuntimeError(reason + 'Windows Harness process tree did not release output pipes')
    # `raw` is for structured output parsed in memory and never written to disk or logs (redaction could corrupt it).
    safe_out = out.decode('utf-8', errors='replace') if options.get('raw') else redact(out.decode('utf-8', errors='replace'), environment)
    safe_err = redact(err.decode('utf-8', errors='replace'), environment)
    reflected_input = options.get('input')
    if reflected_input:
        safe_out = safe_out.replace(reflected_input, '[PROMPT OMITTED]')
        safe_err = safe_err.replace(reflected_input, '[PROMPT OMITTED]')
    if code == 124:
        safe_err += f'\nHarness timeout after {timeout}ms'
    if code == 130:
        safe_err += '\nHarness cancellation'
    if code == 125 or overflow.is_set():
        code = 125
        # A truncated raw token cannot be reliably recognized. Discard both partial streams.
        safe_out, safe_err = '', 'Harness output size limit exceeded; incomplete output discarded'
    result = {'code': code if code is not None else process.returncode,
              'out': safe_out[-tail:], 'err': safe_err[-tail:],
              'durationMs': round((time.monotonic() - started) * 1000)}
    if options.get('persist', True):
        directory = H / 'runtime' / 'output'
        directory.mkdir(parents=True, exist_ok=True)
        file = Path(options['logFile']) if options.get('logFile') else directory / (task_id() + '.log')
        if not file.absolute().is_relative_to(directory.absolute()) or file.is_symlink():
            raise ValueError('Unsafe runner log path')
        if options.get('structured') and options.get('input'):
            # Providers may echo the prompt with arbitrary pretty-printing. Keep transport metadata, not transcripts.
            file.write_text('Structured host transcript omitted to avoid persisting prompts.\n' +
                            'exit=' + str(result['code']) + ' durationMs=' + str(result['durationMs']) + '\n', encoding='utf-8')
        else:
            file.write_text(safe_out + '\n' + safe_err, encoding='utf-8')
        result['log'] = file.relative_to(ROOT).as_posix()
    # Adapters require the integral structured envelope, within the same cap.
    if options.get('structured'):
        result['out'] = safe_out
    return result


def compact_run(cmd, args):
    result = spawn_run(cmd, args)
    return {'command': [cmd, *args], 'exit': result['code'], 'durationMs': result['durationMs'],
            'errors': [line for line in (result['err'] + '\n' + result['out']).splitlines()
                       if any(word in line.lower() for word in ['error', 'fail', 'timeout'])][-12:],
            'tail': (result['err'] + '\n' + result['out'])[-policy()['tailBytes']:], 'log': result.get('log')}
