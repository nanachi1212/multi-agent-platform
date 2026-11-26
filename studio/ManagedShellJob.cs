// Used only by Studio's Windows managed-runtime launcher for a packaged PowerShell.
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ManagedShellJob
{
    class Request {
        public string exe { get; set; }
        public string command { get; set; }
        public string cwd { get; set; }
        public string[] environment { get; set; }
        public string job { get; set; }
        public string ticket { get; set; }
    }
    [DllImport("kernel32", SetLastError=true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    public static int Main() {
        try {
            using (var pipe = new NamedPipeClientStream(".", Environment.GetEnvironmentVariable("STUDIO_JOB_PIPE"), PipeDirection.InOut)) {
                pipe.Connect(10000);
                uint pid;
                Check(GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid), "verify Studio pipe server");
                if (pid.ToString() != Environment.GetEnvironmentVariable("STUDIO_JOB_PARENT")) return 1;
                var reader = new StreamReader(pipe, new UTF8Encoding(false));
                var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
                writer.WriteLine(Environment.GetEnvironmentVariable("STUDIO_JOB_HANDSHAKE"));
                var serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
                var r = serializer.Deserialize<Request>(reader.ReadLine());
                return Run(r.exe, r.command, r.cwd, r.environment, r.job, r.ticket, reader, writer);
            }
        } catch { return 1; }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public uint size;
        public IntPtr reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedBytes;
        public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcessLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits basic;
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
        public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long userTime, kernelTime, userPeriod, kernelPeriod;
        public uint faults, totalProcesses, activeProcesses, terminated;
    }
    [DllImport("kernel32", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int length);
    [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    // READY holds the verified process suspended until Studio has recorded its real PID.
    // EOF before RUN cancels admission. After RUN the Job lives until the shell exits,
    // including if Studio itself closes and a new instance reconnects to the runtime.
    public static int Run(string executable, string command, string cwd, string[] environment, string jobName, string ticket, TextReader input, TextWriter output) {
        IntPtr job = IntPtr.Zero, list = IntPtr.Zero, jobValue = IntPtr.Zero, policy = IntPtr.Zero, env = IntPtr.Zero;
        bool initialized = false, finished = false;
        ProcessInfo target = new ProcessInfo();
        try {
            job = CreateJobObject(IntPtr.Zero, jobName);
            int jobError = Marshal.GetLastWin32Error();
            if (job == IntPtr.Zero || jobError == 183) throw new Win32Exception(jobError, "create private Job");
            ExtendedLimits limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "set Job limits");

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "size startup attributes");
            list = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list, 2, 0, ref size), "initialize startup attributes");
            initialized = true;
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            Check(UpdateProcThreadAttribute(list, 0, (IntPtr)0x2000d, jobValue, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "assign Job at creation");
            policy = Marshal.AllocHGlobal(sizeof(int));
            Marshal.WriteInt32(policy, 2); // PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE
            Check(UpdateProcThreadAttribute(list, 0, (IntPtr)0x20012, policy, (IntPtr)sizeof(int), IntPtr.Zero, IntPtr.Zero), "set desktop app policy");

            StartupInfoEx startup = new StartupInfoEx();
            startup.startup.size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.attributes = list;
            env = Marshal.StringToHGlobalUni(String.Join("\0", environment) + "\0");
            const uint flags = 0x00000004 | 0x00000400 | 0x00080000 | 0x08000000; // suspended, Unicode env, extended startup, no console
            Check(CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
                flags, env, cwd, ref startup, out target), "create requested shell");
            bool member;
            Check(IsProcessInJob(target.process, job, out member), "query Job membership");
            if (!member) throw new InvalidOperationException("target is outside the requested Job");
            int length = 32768;
            StringBuilder image = new StringBuilder(length);
            Check(QueryFullProcessImageName(target.process, 0, image, ref length), "verify target image");
            string name = Path.GetFileName(image.ToString());
            if (!String.Equals(name, "pwsh.exe", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(name, "powershell.exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("activation did not return the shell process");
            long creation, exit, kernel, user;
            Check(GetProcessTimes(target.process, out creation, out exit, out kernel, out user), "verify creation time");
            long unixMilliseconds = (creation - 116444736000000000L) / 10000;
            string imageText = Convert.ToBase64String(Encoding.UTF8.GetBytes(image.ToString()));
            output.WriteLine("READY " + target.pid + " " + unixMilliseconds + " " + imageText); output.Flush();
            if (input.ReadLine() != "RUN") return 1;
            uint previous = ResumeThread(target.thread);
            if (previous != 1) throw new InvalidOperationException("shell thread could not be resumed exactly once");
            output.WriteLine("RUNNING"); output.Flush();
            while (true) {
                uint wait = WaitForSingleObject(target.process, 200);
                if (wait == 0) break;
                Check(wait == 258, "wait for target exit");
                if (File.Exists(ticket + ".stop")) {
                    Check(TerminateJobObject(job, 1), "stop managed Job");
                    Check(WaitForSingleObject(target.process, 5000) == 0, "wait for requested stop");
                    break;
                }
            }
            uint exitCode;
            Check(GetExitCodeProcess(target.process, out exitCode), "read target exit code");
            Accounting accounting;
            uint accountingSize = (uint)Marshal.SizeOf(typeof(Accounting));
            Check(QueryInformationJobObject(job, 1, out accounting, accountingSize, IntPtr.Zero), "count Job members");
            if (accounting.activeProcesses > 0) {
                Check(TerminateJobObject(job, 1), "stop remaining Job members");
                var elapsed = System.Diagnostics.Stopwatch.StartNew();
                do {
                    Thread.Sleep(50);
                    Check(QueryInformationJobObject(job, 1, out accounting, accountingSize, IntPtr.Zero), "confirm Job drain");
                    if (elapsed.ElapsedMilliseconds >= 5000 && accounting.activeProcesses > 0)
                        throw new InvalidOperationException("Job drain timed out");
                } while (accounting.activeProcesses > 0);
            }
            // A restarted Studio reads this only after an atomic rename. Keep control
            // files alongside its registry, outside the managed application's data dir.
            string result = target.pid + " " + exitCode + " 0";
            using (var stream = new FileStream(ticket + ".pending", FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] bytes = Encoding.ASCII.GetBytes(result);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            File.Move(ticket + ".pending", ticket + ".drained");
            File.Delete(ticket + ".stop");
            finished = true;
            return 0;
        } catch (Win32Exception ex) {
            output.WriteLine("ERROR " + ex.Message + " (" + ex.NativeErrorCode + ")"); return 1;
        } catch (InvalidOperationException ex) {
            output.WriteLine("ERROR " + ex.Message); return 1;
        } finally {
            // Even a failed membership check must reap the specific child returned by
            // CreateProcessW. The retained handle cannot target a reused PID.
            if (!finished && target.process != IntPtr.Zero && TerminateProcess(target.process, 1))
                WaitForSingleObject(target.process, 5000);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (target.thread != IntPtr.Zero) CloseHandle(target.thread);
            if (target.process != IntPtr.Zero) CloseHandle(target.process);
            if (initialized) DeleteProcThreadAttributeList(list);
            foreach (IntPtr allocated in new IntPtr[] { list, jobValue, policy, env })
                if (allocated != IntPtr.Zero) Marshal.FreeHGlobal(allocated);
        }
    }
}
