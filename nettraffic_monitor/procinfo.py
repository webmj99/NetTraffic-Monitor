"""Resolve PIDs to executable path, creation time and version-info metadata (ctypes only)."""
import ctypes
import os
from ctypes import wintypes as wt

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ver = ctypes.WinDLL("version", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.OpenProcess.restype = wt.HANDLE
k32.CloseHandle.argtypes = [wt.HANDLE]
k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
k32.GetProcessTimes.argtypes = [wt.HANDLE] + [ctypes.POINTER(wt.FILETIME)] * 4
ver.GetFileVersionInfoSizeW.argtypes = [wt.LPCWSTR, ctypes.POINTER(wt.DWORD)]
ver.GetFileVersionInfoW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p]
ver.VerQueryValueW.argtypes = [ctypes.c_void_p, wt.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wt.UINT)]

SPECIAL = {0: ("System Idle", "[Kernel]"), 4: ("System", "[Kernel] System")}
UNKNOWN_PATH = "[unbekannt]"


def _ft(ft):
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def query(pid):
    """Return (path, creation_filetime) or (None, None) if the process is gone/inaccessible."""
    if pid in SPECIAL:
        return SPECIAL[pid][1], 0
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None, None
    try:
        buf = ctypes.create_unicode_buffer(32768)
        n = wt.DWORD(len(buf))
        path = buf.value if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)) else None
        c, e, k, u = wt.FILETIME(), wt.FILETIME(), wt.FILETIME(), wt.FILETIME()
        created = _ft(c) if k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u)) else 0
        return path, created
    finally:
        k32.CloseHandle(h)


k32.QueryDosDeviceW.argtypes = [wt.LPCWSTR, wt.LPWSTR, wt.DWORD]
k32.K32EnumProcesses.argtypes = [ctypes.POINTER(wt.DWORD), wt.DWORD, ctypes.POINTER(wt.DWORD)]
_devmap = {}


def _load_devmap():
    _devmap.clear()
    buf = ctypes.create_unicode_buffer(1024)
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        if k32.QueryDosDeviceW(letter + ":", buf, len(buf)):
            _devmap[buf.value.lower()] = letter + ":"


def device_to_dos(path):
    """\\Device\\HarddiskVolume3\\x\\y.exe -> C:\\x\\y.exe (as QueryFullProcessImageNameW reports it)."""
    if not path:
        return path
    if path.startswith("\\??\\"):
        return path[4:]
    if path.lower().startswith("\\systemroot\\"):
        return os.environ.get("SystemRoot", "C:\\Windows") + path[11:]
    for attempt in range(2):
        if not _devmap or attempt:
            _load_devmap()
        low = path.lower()
        for dev, drive in _devmap.items():
            if low.startswith(dev + "\\"):
                return drive + path[len(dev):]
    return path


def snapshot():
    """{pid: (path, created)} for all processes currently running."""
    arr = (wt.DWORD * 8192)()
    needed = wt.DWORD()
    if not k32.K32EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(needed)):
        return {}
    out = {}
    for pid in arr[: needed.value // ctypes.sizeof(wt.DWORD)]:
        path, created = query(pid)
        if path:
            out[pid] = (path, created)
    return out


def display_name(path):
    for name, p in SPECIAL.values():
        if p == path:
            return name
    if path == UNKNOWN_PATH:
        return "Unknown (unresolvable)"
    return os.path.basename(path)


def version_info(path):
    """FileDescription / CompanyName / ProductName from the PE version resource."""
    out = {"description": "", "company": "", "product": ""}
    if not path or path.startswith("["):
        return out
    try:
        size = ver.GetFileVersionInfoSizeW(path, None)
        if not size:
            return out
        data = ctypes.create_string_buffer(size)
        if not ver.GetFileVersionInfoW(path, 0, size, data):
            return out
        ptr, ln = ctypes.c_void_p(), wt.UINT()
        langs = []
        if ver.VerQueryValueW(data, r"\VarFileInfo\Translation", ctypes.byref(ptr), ctypes.byref(ln)) and ln.value:
            arr = ctypes.cast(ptr, ctypes.POINTER(wt.WORD * (ln.value // 2))).contents
            langs = [f"{arr[i]:04x}{arr[i + 1]:04x}" for i in range(0, len(arr) - 1, 2)]
        langs += ["040904b0", "040704b0", "040904e4"]
        for key, field in (("description", "FileDescription"), ("company", "CompanyName"), ("product", "ProductName")):
            for lang in langs:
                if ver.VerQueryValueW(data, f"\\StringFileInfo\\{lang}\\{field}", ctypes.byref(ptr), ctypes.byref(ln)) and ln.value:
                    out[key] = ctypes.wstring_at(ptr, ln.value).rstrip("\x00").strip()
                    break
    except OSError:
        pass
    return out


def file_stats(path):
    try:
        st = os.stat(path)
        return {"size": st.st_size, "mtime": int(st.st_mtime)}
    except (OSError, TypeError, ValueError):
        return {"size": None, "mtime": None}
