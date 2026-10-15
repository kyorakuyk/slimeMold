param([switch]$Run)
$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class R7SafeJsonOutputNative
{
    private const uint GenericWrite = 0x40000000;
    private const uint DeleteAccess = 0x00010000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint CreateNewDisposition = 1;
    private const uint FileAttributeNormal = 0x00000080;

    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FileDispositionInformation
    {
        [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateFileW", SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetFinalPathNameByHandleW", SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FileDispositionInformation info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long newPosition, uint moveMethod);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetEndOfFile(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle handle);

    public static SafeFileHandle OpenNew(string path)
    {
        return CreateFile(path, GenericWrite | DeleteAccess | FileReadAttributes, 0, IntPtr.Zero, CreateNewDisposition, FileAttributeNormal, IntPtr.Zero);
    }

    public static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(1024);
        uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= buffer.Capacity)
        {
            buffer = new StringBuilder((int)length + 1);
            length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return buffer.ToString();
    }

    public static uint LinkCount(SafeFileHandle handle)
    {
        ByHandleFileInformation info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return info.NumberOfLinks;
    }

    public static void DeleteByHandle(SafeFileHandle handle)
    {
        var info = new FileDispositionInformation { DeleteFile = true };
        if (!SetFileInformationByHandle(handle, 4, ref info, (uint)Marshal.SizeOf(typeof(FileDispositionInformation))))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void WriteJson(SafeFileHandle handle, string json)
    {
        long position;
        if (!SetFilePointerEx(handle, 0, out position, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!SetEndOfFile(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        byte[] bytes = new UTF8Encoding(false).GetBytes(json);
        uint written;
        if (!WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (written != bytes.Length) throw new InvalidOperationException("Short write while writing JSON output.");
        if (!FlushFileBuffers(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

if (-not ('R7SafeJsonOutputNative' -as [type])) {
  Add-Type -TypeDefinition $nativeSource
}

function Test-R7PathInsideRepository([string]$CandidatePath, [string]$RepositoryRoot) {
  if ($CandidatePath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    $CandidatePath = '\\' + $CandidatePath.Substring(8)
  } elseif ($CandidatePath.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    $CandidatePath = $CandidatePath.Substring(4)
  }
  $candidate = [IO.Path]::GetFullPath($CandidatePath).TrimEnd([char[]]@('\', '/'))
  $root = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([char[]]@('\', '/'))
  $prefix = $root + [IO.Path]::DirectorySeparatorChar
  return $candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Write-R7SafeJsonOutput {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$JsonText,
    [scriptblock]$AfterOpen
  )

  $handle = [R7SafeJsonOutputNative]::OpenNew($OutputPath)
  if ($handle.IsInvalid) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $handle.Dispose()
    throw [ComponentModel.Win32Exception]::new($code)
  }
  $committed = $false
  try {
    if ($AfterOpen) { & $AfterOpen }
    $actualPath = [R7SafeJsonOutputNative]::FinalPath($handle)
    if (Test-R7PathInsideRepository $actualPath $RepositoryRoot) {
      throw "--json output resolves inside the repository (refusing to write `"$actualPath`")"
    }
    if ([R7SafeJsonOutputNative]::LinkCount($handle) -ne 1) {
      throw '--json output target has multiple hard links (refusing to write)'
    }
    [R7SafeJsonOutputNative]::WriteJson($handle, $JsonText)
    $committed = $true
  } catch {
    $failure = $_
    if (-not $committed -and -not $handle.IsInvalid) {
      try { [R7SafeJsonOutputNative]::DeleteByHandle($handle) }
      catch { throw "JSON output failed and handle-bound cleanup failed: $($_.Exception.Message); original error: $($failure.Exception.Message)" }
    }
    throw $failure
  } finally {
    $handle.Dispose()
  }
}

if ($Run) {
  try {
    $requestText = [Console]::In.ReadToEnd()
    $request = ConvertFrom-Json -InputObject $requestText
    Write-R7SafeJsonOutput -OutputPath $request.outputPath -RepositoryRoot $request.repositoryRoot -JsonText $request.jsonText
    [Console]::Out.WriteLine('ok')
    exit 0
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
  }
}
