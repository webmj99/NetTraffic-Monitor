"""Minimal real-time ETW consumer for Kernel-Network and Kernel-Process (ctypes only, needs admin)."""
import ctypes
import struct
import threading
import uuid
from ctypes import wintypes as wt

advapi = ctypes.WinDLL("advapi32", use_last_error=True)

ULONG64 = ctypes.c_uint64
TRACEHANDLE = ctypes.c_uint64
INVALID_PROCESSTRACE_HANDLE = 0xFFFFFFFFFFFFFFFF

WNODE_FLAG_TRACED_GUID = 0x00020000
EVENT_TRACE_REAL_TIME_MODE = 0x00000100
EVENT_TRACE_CONTROL_QUERY = 0
EVENT_TRACE_CONTROL_STOP = 1
EVENT_CONTROL_CODE_ENABLE_PROVIDER = 1
PROCESS_TRACE_MODE_REAL_TIME = 0x00000100
PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000
ERROR_ALREADY_EXISTS = 183
TRACE_LEVEL_VERBOSE = 5

KERNEL_NETWORK_GUID = "{7DD42A49-5329-4832-8DFD-43D979153A88}"
KERNEL_NETWORK_KEYWORDS = 0x10 | 0x20  # KEYWORD_IPV4 | KEYWORD_IPV6
KERNEL_PROCESS_GUID = "{22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716}"
KERNEL_PROCESS_KEYWORDS = 0x10          # WINEVENT_KEYWORD_PROCESS (start/stop)
_PROCESS_D1 = 0x22FB2CD6

# event id -> (is_upload, is_ipv6)
EVENTS = {
    10: (True, False), 11: (False, False),   # TCP v4 send / recv
    26: (True, True), 27: (False, True),     # TCP v6 send / recv
    42: (True, False), 43: (False, False),   # UDP v4 send / recv
    58: (True, True), 59: (False, True),     # UDP v6 send / recv
}


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wt.DWORD), ("Data2", wt.WORD), ("Data3", wt.WORD), ("Data4", ctypes.c_ubyte * 8)]

    @classmethod
    def from_str(cls, s):
        return cls.from_buffer_copy(uuid.UUID(s).bytes_le)


class WNODE_HEADER(ctypes.Structure):
    _fields_ = [
        ("BufferSize", wt.ULONG), ("ProviderId", wt.ULONG), ("HistoricalContext", ULONG64),
        ("TimeStamp", ctypes.c_int64), ("Guid", GUID), ("ClientContext", wt.ULONG), ("Flags", wt.ULONG),
    ]


class EVENT_TRACE_PROPERTIES(ctypes.Structure):
    _fields_ = [
        ("Wnode", WNODE_HEADER), ("BufferSize", wt.ULONG), ("MinimumBuffers", wt.ULONG),
        ("MaximumBuffers", wt.ULONG), ("MaximumFileSize", wt.ULONG), ("LogFileMode", wt.ULONG),
        ("FlushTimer", wt.ULONG), ("EnableFlags", wt.ULONG), ("AgeLimit", wt.LONG),
        ("NumberOfBuffers", wt.ULONG), ("FreeBuffers", wt.ULONG), ("EventsLost", wt.ULONG),
        ("BuffersWritten", wt.ULONG), ("LogBuffersLost", wt.ULONG), ("RealTimeBuffersLost", wt.ULONG),
        ("LoggerThreadId", wt.HANDLE), ("LogFileNameOffset", wt.ULONG), ("LoggerNameOffset", wt.ULONG),
    ]


class EVENT_TRACE_HEADER(ctypes.Structure):
    _fields_ = [
        ("Size", wt.USHORT), ("FieldTypeFlags", wt.USHORT), ("Version", wt.ULONG), ("ThreadId", wt.ULONG),
        ("ProcessId", wt.ULONG), ("TimeStamp", ctypes.c_int64), ("Guid", GUID), ("ProcessorTime", ULONG64),
    ]


class EVENT_TRACE(ctypes.Structure):
    _fields_ = [
        ("Header", EVENT_TRACE_HEADER), ("InstanceId", wt.ULONG), ("ParentInstanceId", wt.ULONG),
        ("ParentGuid", GUID), ("MofData", ctypes.c_void_p), ("MofLength", wt.ULONG), ("ClientContext", wt.ULONG),
    ]


class SYSTEMTIME(ctypes.Structure):
    _fields_ = [(n, wt.WORD) for n in ("wYear", "wMonth", "wDayOfWeek", "wDay", "wHour", "wMinute", "wSecond", "wMs")]


class TIME_ZONE_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Bias", wt.LONG), ("StandardName", wt.WCHAR * 32), ("StandardDate", SYSTEMTIME), ("StandardBias", wt.LONG),
        ("DaylightName", wt.WCHAR * 32), ("DaylightDate", SYSTEMTIME), ("DaylightBias", wt.LONG),
    ]


class TRACE_LOGFILE_HEADER(ctypes.Structure):
    _fields_ = [
        ("BufferSize", wt.ULONG), ("Version", wt.ULONG), ("ProviderVersion", wt.ULONG),
        ("NumberOfProcessors", wt.ULONG), ("EndTime", ctypes.c_int64), ("TimerResolution", wt.ULONG),
        ("MaximumFileSize", wt.ULONG), ("LogFileMode", wt.ULONG), ("BuffersWritten", wt.ULONG),
        ("LogInstanceGuid", GUID), ("LoggerName", wt.LPWSTR), ("LogFileName", wt.LPWSTR),
        ("TimeZone", TIME_ZONE_INFORMATION), ("BootTime", ctypes.c_int64), ("PerfFreq", ctypes.c_int64),
        ("StartTime", ctypes.c_int64), ("ReservedFlags", wt.ULONG), ("BuffersLost", wt.ULONG),
    ]


class EVENT_DESCRIPTOR(ctypes.Structure):
    _fields_ = [
        ("Id", wt.USHORT), ("Version", ctypes.c_ubyte), ("Channel", ctypes.c_ubyte), ("Level", ctypes.c_ubyte),
        ("Opcode", ctypes.c_ubyte), ("Task", wt.USHORT), ("Keyword", ctypes.c_uint64),
    ]


class EVENT_HEADER(ctypes.Structure):
    _fields_ = [
        ("Size", wt.USHORT), ("HeaderType", wt.USHORT), ("Flags", wt.USHORT), ("EventProperty", wt.USHORT),
        ("ThreadId", wt.ULONG), ("ProcessId", wt.ULONG), ("TimeStamp", ctypes.c_int64), ("ProviderId", GUID),
        ("EventDescriptor", EVENT_DESCRIPTOR), ("ProcessorTime", ULONG64), ("ActivityId", GUID),
    ]


class EVENT_RECORD(ctypes.Structure):
    _fields_ = [
        ("EventHeader", EVENT_HEADER), ("BufferContext", wt.ULONG), ("ExtendedDataCount", wt.USHORT),
        ("UserDataLength", wt.USHORT), ("ExtendedData", ctypes.c_void_p), ("UserData", ctypes.c_void_p),
        ("UserContext", ctypes.c_void_p),
    ]


EVENT_RECORD_CALLBACK = ctypes.WINFUNCTYPE(None, ctypes.POINTER(EVENT_RECORD))
BUFFER_CALLBACK = ctypes.WINFUNCTYPE(wt.ULONG, ctypes.c_void_p)


class EVENT_TRACE_LOGFILEW(ctypes.Structure):
    _fields_ = [
        ("LogFileName", wt.LPWSTR), ("LoggerName", wt.LPWSTR), ("CurrentTime", ctypes.c_int64),
        ("BuffersRead", wt.ULONG), ("ProcessTraceMode", wt.ULONG), ("CurrentEvent", EVENT_TRACE),
        ("LogfileHeader", TRACE_LOGFILE_HEADER), ("BufferCallback", BUFFER_CALLBACK), ("BufferSize", wt.ULONG),
        ("Filled", wt.ULONG), ("EventsLost", wt.ULONG), ("EventRecordCallback", EVENT_RECORD_CALLBACK),
        ("IsKernelTrace", wt.ULONG), ("Context", ctypes.c_void_p),
    ]


advapi.StartTraceW.argtypes = [ctypes.POINTER(TRACEHANDLE), wt.LPCWSTR, ctypes.c_void_p]
advapi.StartTraceW.restype = wt.ULONG
advapi.ControlTraceW.argtypes = [TRACEHANDLE, wt.LPCWSTR, ctypes.c_void_p, wt.ULONG]
advapi.ControlTraceW.restype = wt.ULONG
advapi.EnableTraceEx2.argtypes = [TRACEHANDLE, ctypes.POINTER(GUID), wt.ULONG, ctypes.c_ubyte,
                                  ctypes.c_uint64, ctypes.c_uint64, wt.ULONG, ctypes.c_void_p]
advapi.EnableTraceEx2.restype = wt.ULONG
advapi.OpenTraceW.argtypes = [ctypes.POINTER(EVENT_TRACE_LOGFILEW)]
advapi.OpenTraceW.restype = TRACEHANDLE
advapi.ProcessTrace.argtypes = [ctypes.POINTER(TRACEHANDLE), wt.ULONG, ctypes.c_void_p, ctypes.c_void_p]
advapi.ProcessTrace.restype = wt.ULONG
advapi.CloseTrace.argtypes = [TRACEHANDLE]
advapi.CloseTrace.restype = wt.ULONG

FILETIME_UNIX_OFFSET = 116444736000000000
_V4 = struct.Struct("<II4s4s2s2s")
_V6 = struct.Struct("<II16s16s2s2s")


def _props_buffer(name):
    size = ctypes.sizeof(EVENT_TRACE_PROPERTIES) + (len(name) + 1) * 2 + 2048
    buf = ctypes.create_string_buffer(size)
    p = EVENT_TRACE_PROPERTIES.from_buffer(buf)
    p.Wnode.BufferSize = size
    p.Wnode.Flags = WNODE_FLAG_TRACED_GUID
    p.Wnode.ClientContext = 2  # system time -> EVENT_HEADER.TimeStamp is FILETIME
    p.LogFileMode = EVENT_TRACE_REAL_TIME_MODE
    p.FlushTimer = 1
    p.BufferSize = 64  # KB
    p.MinimumBuffers = 8
    p.MaximumBuffers = 64
    p.LoggerNameOffset = ctypes.sizeof(EVENT_TRACE_PROPERTIES)
    return buf, p


def _parse_process(eid, raw):
    """ProcessStart (1) / ProcessStop (2): both begin with ProcessID u32, CreateTime FILETIME.
    The start event's ImageName is a NT device path (\\Device\\HarddiskVolumeN\\...); its offset
    differs between event versions, so it is located by its prefix instead of a fixed offset."""
    pid, created = struct.unpack_from("<IQ", raw, 0)
    if eid != 1:
        return pid, created, None
    i = raw.find(_DEVICE, 12)
    while i != -1 and i % 2:
        i = raw.find(_DEVICE, i + 1)
    if i == -1:
        return pid, created, None
    j = i
    while j + 1 < len(raw) and raw[j:j + 2] != b"\x00\x00":
        j += 2
    return pid, created, raw[i:j].decode("utf-16-le", "replace")


_DEVICE = "\\Device\\".encode("utf-16-le")


class NetworkTrace:
    """Runs an ETW real-time session; calls on_event(sec, pid, size, upload, daddr, saddr, v6, dport, sport, udp)
    for network traffic and on_process(started, pid, created_filetime, device_path) for process start/stop."""

    def __init__(self, on_event, on_process=None, session_name="NetTrafficMonitorKernelNetwork"):
        self.on_event = on_event
        self.on_process = on_process
        self.name = session_name
        self.session = TRACEHANDLE(0)
        self.consumer = TRACEHANDLE(INVALID_PROCESSTRACE_HANDLE)
        self.thread = None
        self._cb = EVENT_RECORD_CALLBACK(self._callback)
        self.error = None

    def _callback(self, rec_ptr):
        try:
            rec = rec_ptr.contents
            eid = rec.EventHeader.EventDescriptor.Id
            if rec.EventHeader.ProviderId.Data1 == _PROCESS_D1:
                if eid in (1, 2) and self.on_process and rec.UserDataLength >= 12:
                    pid, created, path = _parse_process(eid, ctypes.string_at(rec.UserData, rec.UserDataLength))
                    self.on_process(eid == 1, pid, created, path)
                return
            info = EVENTS.get(eid)
            if info is None:
                return
            upload, v6 = info
            layout = _V6 if v6 else _V4
            if rec.UserDataLength < layout.size:
                return
            raw = ctypes.string_at(rec.UserData, layout.size)
            pid, size, daddr, saddr, dport, sport = layout.unpack(raw)
            sec = (rec.EventHeader.TimeStamp - FILETIME_UNIX_OFFSET) // 10_000_000
            udp = eid >= 42
            self.on_event(sec, pid, size, upload, daddr, saddr, v6,
                          int.from_bytes(dport, "big"), int.from_bytes(sport, "big"), udp)
        except Exception:  # never let an exception escape into ETW
            pass

    def lost(self):
        """[events, real-time buffers] dropped by ETW so far (buffers full / consumer too slow)."""
        buf, p = _props_buffer(self.name)
        if advapi.ControlTraceW(0, self.name, buf, EVENT_TRACE_CONTROL_QUERY) != 0:
            return [0, 0]
        return [p.EventsLost, p.RealTimeBuffersLost]

    def _stop_session(self, name):
        buf, _ = _props_buffer(name)
        return advapi.ControlTraceW(0, name, buf, EVENT_TRACE_CONTROL_STOP)

    def start(self):
        buf, _ = _props_buffer(self.name)
        rc = advapi.StartTraceW(ctypes.byref(self.session), self.name, buf)
        if rc == ERROR_ALREADY_EXISTS:  # stale session from a crashed run
            self._stop_session(self.name)
            buf, _ = _props_buffer(self.name)
            rc = advapi.StartTraceW(ctypes.byref(self.session), self.name, buf)
        if rc != 0:
            raise OSError(rc, f"StartTraceW failed ({ctypes.FormatError(rc).strip()})")

        providers = [(KERNEL_NETWORK_GUID, KERNEL_NETWORK_KEYWORDS)]
        if self.on_process:
            providers.append((KERNEL_PROCESS_GUID, KERNEL_PROCESS_KEYWORDS))
        for guid_str, keywords in providers:
            guid = GUID.from_str(guid_str)
            rc = advapi.EnableTraceEx2(self.session, ctypes.byref(guid), EVENT_CONTROL_CODE_ENABLE_PROVIDER,
                                       TRACE_LEVEL_VERBOSE, keywords, 0, 0, None)
            if rc != 0:
                self._stop_session(self.name)
                raise OSError(rc, f"EnableTraceEx2 failed ({ctypes.FormatError(rc).strip()})")

        lf = EVENT_TRACE_LOGFILEW()
        lf.LoggerName = self.name
        lf.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD
        lf.EventRecordCallback = self._cb
        self._logfile = lf
        self.consumer = TRACEHANDLE(advapi.OpenTraceW(ctypes.byref(lf)))
        if self.consumer.value == INVALID_PROCESSTRACE_HANDLE:
            err = ctypes.get_last_error()
            self._stop_session(self.name)
            raise OSError(err, "OpenTraceW failed")

        self.thread = threading.Thread(target=self._run, name="etw-consumer", daemon=True)
        self.thread.start()

    def _run(self):
        rc = advapi.ProcessTrace(ctypes.byref(self.consumer), 1, None, None)
        if rc not in (0, 1223):  # 1223 = ERROR_CANCELLED
            self.error = rc

    def stop(self):
        self._stop_session(self.name)
        if self.consumer.value != INVALID_PROCESSTRACE_HANDLE:
            advapi.CloseTrace(self.consumer)
            self.consumer = TRACEHANDLE(INVALID_PROCESSTRACE_HANDLE)
        if self.thread:
            self.thread.join(timeout=5)
            self.thread = None
