"""Windows service host for NetTraffic-Monitor (stdlib only, talks to the Service Control Manager via ctypes).

Installed by install-service.ps1 as: python.exe "<NetTraffic-Monitor>\\service.py"
Extra arguments are passed to NetTraffic-Monitor (e.g. --port 8765). Output goes to data\\service.log.
"""
import ctypes
import os
import sys
import threading
import traceback
from ctypes import wintypes as wt

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

SERVICE_NAME = "NetTraffic-Monitor"
SERVICE_WIN32_OWN_PROCESS = 0x10
SERVICE_STOPPED, SERVICE_START_PENDING, SERVICE_STOP_PENDING, SERVICE_RUNNING = 1, 2, 3, 4
SERVICE_ACCEPT_STOP, SERVICE_ACCEPT_SHUTDOWN = 0x1, 0x4
SERVICE_CONTROL_STOP, SERVICE_CONTROL_INTERROGATE, SERVICE_CONTROL_SHUTDOWN = 1, 4, 5
NO_ERROR, ERROR_CALL_NOT_IMPLEMENTED, ERROR_SERVICE_SPECIFIC_ERROR = 0, 120, 1066
ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063


class SERVICE_STATUS(ctypes.Structure):
    _fields_ = [(n, wt.DWORD) for n in ("dwServiceType", "dwCurrentState", "dwControlsAccepted", "dwWin32ExitCode",
                                        "dwServiceSpecificExitCode", "dwCheckPoint", "dwWaitHint")]


SERVICE_MAIN = ctypes.WINFUNCTYPE(None, wt.DWORD, ctypes.POINTER(wt.LPWSTR))
HANDLER_EX = ctypes.WINFUNCTYPE(wt.DWORD, wt.DWORD, wt.DWORD, wt.LPVOID, wt.LPVOID)


class SERVICE_TABLE_ENTRYW(ctypes.Structure):
    _fields_ = [("lpServiceName", wt.LPWSTR), ("lpServiceProc", SERVICE_MAIN)]


advapi = ctypes.WinDLL("advapi32", use_last_error=True)
advapi.RegisterServiceCtrlHandlerExW.restype = wt.HANDLE
advapi.RegisterServiceCtrlHandlerExW.argtypes = [wt.LPCWSTR, HANDLER_EX, wt.LPVOID]
advapi.SetServiceStatus.argtypes = [wt.HANDLE, ctypes.POINTER(SERVICE_STATUS)]
advapi.StartServiceCtrlDispatcherW.argtypes = [ctypes.POINTER(SERVICE_TABLE_ENTRYW)]

stop_event = threading.Event()
status = SERVICE_STATUS(SERVICE_WIN32_OWN_PROCESS)
status_handle = None


def set_status(state, exit_code=0, wait_hint=0):
    status.dwCurrentState = state
    status.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN if state == SERVICE_RUNNING else 0
    status.dwWin32ExitCode = ERROR_SERVICE_SPECIFIC_ERROR if exit_code else NO_ERROR
    status.dwServiceSpecificExitCode = exit_code
    status.dwCheckPoint = 0 if state in (SERVICE_RUNNING, SERVICE_STOPPED) else status.dwCheckPoint + 1
    status.dwWaitHint = wait_hint
    advapi.SetServiceStatus(status_handle, ctypes.byref(status))


@HANDLER_EX
def handler(control, event_type, event_data, context):
    if control in (SERVICE_CONTROL_STOP, SERVICE_CONTROL_SHUTDOWN):
        set_status(SERVICE_STOP_PENDING, wait_hint=15000)
        stop_event.set()
        return NO_ERROR
    if control == SERVICE_CONTROL_INTERROGATE:
        return NO_ERROR
    return ERROR_CALL_NOT_IMPLEMENTED


@SERVICE_MAIN
def service_main(argc, argv):
    global status_handle
    status_handle = advapi.RegisterServiceCtrlHandlerExW(SERVICE_NAME, handler, None)
    set_status(SERVICE_START_PENDING, wait_hint=10000)
    exit_code = 0
    try:
        from nettraffic_monitor.__main__ import main
        set_status(SERVICE_RUNNING)
        main(["--no-browser", *sys.argv[1:]], stop_event)
    except BaseException:
        traceback.print_exc()
        exit_code = 1
    sys.stdout.flush()
    set_status(SERVICE_STOPPED, exit_code)


def open_log():
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    log = open(os.path.join(ROOT, "data", "service.log"), "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log


if __name__ == "__main__":
    open_log()
    table = (SERVICE_TABLE_ENTRYW * 2)(SERVICE_TABLE_ENTRYW(SERVICE_NAME, service_main), SERVICE_TABLE_ENTRYW())
    if not advapi.StartServiceCtrlDispatcherW(table):
        err = ctypes.get_last_error()
        if sys.__stderr__:
            print("service.py must be started by the Service Control Manager (install-service.ps1). "
                  "Run start.bat for console mode.", file=sys.__stderr__)
        sys.exit(err or ERROR_FAILED_SERVICE_CONTROLLER_CONNECT)
