$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentTerm.QualityGate
{
    public sealed class GateJobResult
    {
        public string kind;
        public long exitCode;
        public bool terminationFailed;
    }

    public static class WindowsJobProcess
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint INFINITE = 0xffffffff;
        private const uint STILL_ACTIVE = 259;
        private const int JobObjectExtendedLimitInformation = 9;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint CLEANUP_WAIT_MS = 5000;

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        public static GateJobResult Run(
            string executablePath,
            string[] arguments,
            string workingDirectory,
            Dictionary<string, string> environment,
            int timeoutMs)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr environmentBlock = IntPtr.Zero;
            IntPtr nullInput = new IntPtr(-1);
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            bool assignedToJob = false;
            bool processCreated = false;

            try
            {
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                ConfigureJob(job);

                SECURITY_ATTRIBUTES nullAttributes = new SECURITY_ATTRIBUTES();
                nullAttributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                nullAttributes.bInheritHandle = true;
                nullInput = CreateFileW(
                    "NUL",
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    ref nullAttributes,
                    OPEN_EXISTING,
                    0,
                    IntPtr.Zero);
                if (IsInvalidHandle(nullInput))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                IntPtr stdout = GetStdHandle(STD_OUTPUT_HANDLE);
                IntPtr stderr = GetStdHandle(STD_ERROR_HANDLE);
                if (IsInvalidHandle(stdout) || IsInvalidHandle(stderr))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = nullInput;
                startup.hStdOutput = stdout;
                startup.hStdError = stderr;

                environmentBlock = Marshal.StringToHGlobalUni(BuildEnvironmentBlock(environment));
                StringBuilder commandLine = new StringBuilder(BuildCommandLine(executablePath, arguments));
                if (!CreateProcessW(
                    executablePath,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                    environmentBlock,
                    workingDirectory,
                    ref startup,
                    out process))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                processCreated = true;

                if (!AssignProcessToJobObject(job, process.hProcess))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                assignedToJob = true;
                if (ResumeThread(process.hThread) == INFINITE)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                if (WaitForJobEmpty(job, (uint)timeoutMs))
                {
                    uint exitCode;
                    if (!GetExitCodeProcess(process.hProcess, out exitCode) || exitCode == STILL_ACTIVE)
                    {
                        return InfrastructureFailure(false);
                    }
                    return new GateJobResult
                    {
                        kind = "exited",
                        exitCode = exitCode,
                        terminationFailed = false
                    };
                }
                else
                {
                    TerminateJobObject(job, 1);
                    bool settled = WaitForJobEmpty(job, CLEANUP_WAIT_MS);
                    return new GateJobResult
                    {
                        kind = "timed-out",
                        exitCode = 0,
                        terminationFailed = !settled
                    };
                }
            }
            catch
            {
                bool settled = !processCreated;
                if (job != IntPtr.Zero)
                {
                    settled = assignedToJob ? TerminateAndWait(job) : settled;
                }
                if (processCreated && !assignedToJob && process.hProcess != IntPtr.Zero)
                {
                    settled = StopUnassignedProcess(process.hProcess);
                }
                return InfrastructureFailure(!settled);
            }
            finally
            {
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
                if (!IsInvalidHandle(nullInput)) CloseHandle(nullInput);
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }

        private static GateJobResult InfrastructureFailure(bool terminationFailed)
        {
            return new GateJobResult
            {
                kind = "infrastructure-error",
                exitCode = 0,
                terminationFailed = terminationFailed
            };
        }

        private static void ConfigureJob(IntPtr job)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static bool TerminateAndWait(IntPtr job)
        {
            try
            {
                TerminateJobObject(job, 1);
                return WaitForJobEmpty(job, CLEANUP_WAIT_MS);
            }
            catch
            {
                return false;
            }
        }

        private static bool WaitForJobEmpty(IntPtr job, uint timeoutMs)
        {
            long deadline = DateTime.UtcNow.Ticks + TimeSpan.FromMilliseconds(timeoutMs).Ticks;
            while (true)
            {
                if (ReadActiveProcessCount(job) == 0)
                {
                    return true;
                }
                long remainingTicks = deadline - DateTime.UtcNow.Ticks;
                if (remainingTicks <= 0)
                {
                    return false;
                }
                int remainingMs = (int)Math.Min(
                    TimeSpan.FromTicks(remainingTicks).TotalMilliseconds,
                    10);
                System.Threading.Thread.Sleep(Math.Max(remainingMs, 1));
            }
        }

        private static uint ReadActiveProcessCount(IntPtr job)
        {
            int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    buffer,
                    (uint)size,
                    IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information =
                    (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                        buffer,
                        typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
                return information.ActiveProcesses;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static bool StopUnassignedProcess(IntPtr process)
        {
            TerminateProcess(process, 1);
            return WaitForSingleObject(process, CLEANUP_WAIT_MS) == WAIT_OBJECT_0;
        }

        private static bool IsInvalidHandle(IntPtr handle)
        {
            return handle == IntPtr.Zero || handle == new IntPtr(-1);
        }

        private static string BuildEnvironmentBlock(Dictionary<string, string> environment)
        {
            List<string> entries = new List<string>();
            foreach (KeyValuePair<string, string> entry in environment)
            {
                entries.Add(entry.Key + "=" + entry.Value);
            }
            entries.Sort(StringComparer.OrdinalIgnoreCase);
            return String.Join("\0", entries.ToArray()) + "\0";
        }

        private static string BuildCommandLine(string executablePath, string[] arguments)
        {
            StringBuilder commandLine = new StringBuilder(QuoteArgument(executablePath));
            foreach (string argument in arguments)
            {
                commandLine.Append(' ');
                commandLine.Append(QuoteArgument(argument));
            }
            return commandLine.ToString();
        }

        private static string QuoteArgument(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return argument;
            }

            StringBuilder quoted = new StringBuilder();
            quoted.Append('"');
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }
    }
}
'@

$nonce = $null

function Write-AgentTermResult([object] $result) {
    $json = ConvertTo-Json -Compress -Depth 3 -InputObject $result
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    [Console]::Out.Write("`nAGENTTERM_JOB_RESULT:${nonce}:${encoded}`n")
    [Console]::Out.Flush()
}

try {
    $requestText = [Console]::In.ReadToEnd()
    if ($requestText.Length -gt 16777216) { throw 'invalid request' }
    $request = ConvertFrom-Json -InputObject $requestText
    if ($request.schemaVersion -ne 1) { throw 'invalid request' }
    $nonce = [string] $request.nonce
    if ($nonce -notmatch '^[0-9a-f]{64}$') { throw 'invalid request' }
    if ([string]::IsNullOrEmpty([string] $request.executablePath)) { throw 'invalid request' }
    if ([string]::IsNullOrEmpty([string] $request.workingDirectory)) { throw 'invalid request' }
    $timeoutMs = [int64] $request.timeoutMs
    if ($timeoutMs -lt 1 -or $timeoutMs -gt 86400000) { throw 'invalid request' }

    $arguments = New-Object System.Collections.Generic.List[string]
    foreach ($argument in @($request.arguments)) {
        if ($null -eq $argument -or $argument -isnot [string] -or $argument.Contains([char] 0)) {
            throw 'invalid request'
        }
        $arguments.Add([string] $argument)
    }

    $environment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $request.environment.PSObject.Properties) {
        $name = [string] $property.Name
        $value = $property.Value
        if (
            [string]::IsNullOrEmpty($name) -or
            $name.Contains('=') -or
            $name.Contains([char] 0) -or
            $value -isnot [string] -or
            $value.Contains([char] 0)
        ) {
            throw 'invalid request'
        }
        $environment.Add($name, [string] $value)
    }

    Add-Type -TypeDefinition $source -Language CSharp
    $result = [AgentTerm.QualityGate.WindowsJobProcess]::Run(
        [string] $request.executablePath,
        $arguments.ToArray(),
        [string] $request.workingDirectory,
        $environment,
        [int] $timeoutMs)
    Write-AgentTermResult $result
    exit 0
} catch {
    if ($nonce -match '^[0-9a-f]{64}$') {
        Write-AgentTermResult ([ordered]@{
            kind = 'infrastructure-error'
            exitCode = 0
            terminationFailed = $false
        })
        exit 0
    }
    exit 1
}
