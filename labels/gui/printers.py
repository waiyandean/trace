#!/usr/bin/env python3
"""Getting ZPL to the printer, by whichever route this machine has.

Four backends, tried in the order below unless one is named explicitly:

  winspool   Windows, raw bytes handed to the spooler by printer name. No
             share, no \\\\localhost, no Server or Workstation service. This is
             the one to use: the share route depends on three separate pieces
             of Windows networking staying switched on, and on this machine it
             has already failed once with nothing obviously wrong.
  share      Windows, `copy /b file \\\\localhost\\ZEBRA`. Kept because it is
             what the kitchen has used until now and it is a useful thing to
             fall back to when the spooler route misbehaves.
  tcp        Straight to port 9100. Unused today, and the route the whole
             system moves to once the printer is on the network.
  folder     Writes the .zpl to a directory and prints nothing. What runs on
             a development machine, and what the Drive-folder workflow did by
             hand.

RAW is what matters in all of them. Handing ZPL to a driver that renders it
gets a page of text reading "^XA^FO40,42..." rather than a label.
"""
import platform
import socket
import subprocess
import tempfile
from pathlib import Path

IS_WINDOWS = platform.system() == "Windows"


class PrintError(RuntimeError):
    pass


# --- Windows spooler, raw ----------------------------------------------------

def _winspool():
    import ctypes
    from ctypes import wintypes

    winspool = ctypes.WinDLL("winspool.drv")

    class DOC_INFO_1(ctypes.Structure):
        _fields_ = [("pDocName", wintypes.LPWSTR),
                    ("pOutputFile", wintypes.LPWSTR),
                    ("pDatatype", wintypes.LPWSTR)]

    class PRINTER_INFO_4(ctypes.Structure):
        _fields_ = [("pPrinterName", wintypes.LPWSTR),
                    ("pServerName", wintypes.LPWSTR),
                    ("Attributes", wintypes.DWORD)]

    return ctypes, wintypes, winspool, DOC_INFO_1, PRINTER_INFO_4


def list_windows_printers():
    """Every printer this machine can see, local and connected."""
    if not IS_WINDOWS:
        return []
    ctypes, wintypes, winspool, _, PRINTER_INFO_4 = _winspool()
    PRINTER_ENUM_LOCAL, PRINTER_ENUM_CONNECTIONS = 0x2, 0x4
    flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS

    needed = wintypes.DWORD(0)
    returned = wintypes.DWORD(0)
    # First call asks how much room the answer needs; it is expected to fail.
    winspool.EnumPrintersW(flags, None, 4, None, 0,
                           ctypes.byref(needed), ctypes.byref(returned))
    if not needed.value:
        return []
    buf = ctypes.create_string_buffer(needed.value)
    if not winspool.EnumPrintersW(flags, None, 4, buf, needed.value,
                                  ctypes.byref(needed), ctypes.byref(returned)):
        return []
    info = ctypes.cast(buf, ctypes.POINTER(PRINTER_INFO_4))
    return [info[i].pPrinterName for i in range(returned.value)]


def print_winspool(data, printer):
    ctypes, wintypes, winspool, DOC_INFO_1, _ = _winspool()
    handle = wintypes.HANDLE()
    if not winspool.OpenPrinterW(printer, ctypes.byref(handle), None):
        raise PrintError(
            f"Windows would not open the printer {printer!r}. Check the name "
            f"against the list on the settings screen.")
    try:
        # RAW is the whole point: it tells the spooler to pass the bytes to the
        # printer untouched rather than letting a driver render them as text.
        doc = DOC_INFO_1("trace label", None, "RAW")
        job = winspool.StartDocPrinterW(handle, 1, ctypes.byref(doc))
        if not job:
            raise PrintError(f"The spooler refused the job for {printer!r}.")
        try:
            winspool.StartPagePrinter(handle)
            written = wintypes.DWORD(0)
            buf = ctypes.create_string_buffer(data, len(data))
            ok = winspool.WritePrinter(handle, buf, len(data),
                                       ctypes.byref(written))
            winspool.EndPagePrinter(handle)
            if not ok or written.value != len(data):
                raise PrintError(
                    f"Only {written.value} of {len(data)} bytes reached the "
                    f"printer.")
        finally:
            winspool.EndDocPrinter(handle)
    finally:
        winspool.ClosePrinter(handle)
    return f"sent {len(data)} bytes to {printer}"


# --- the other three ---------------------------------------------------------

def print_share(data, share):
    """`copy /b` to a shared printer, the route used before this tool existed."""
    tmp = Path(tempfile.gettempdir()) / "trace-label.zpl"
    tmp.write_bytes(data)
    dest = share if share.startswith("\\\\") else f"\\\\localhost\\{share}"
    result = subprocess.run(["cmd", "/c", "copy", "/b", str(tmp), dest],
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise PrintError(
            (result.stderr or result.stdout or "copy failed").strip()
            + f"  (destination {dest})")
    return f"copied {len(data)} bytes to {dest}"


def print_tcp(data, host, port=9100):
    try:
        with socket.create_connection((host, port), timeout=5) as sock:
            sock.sendall(data)
    except OSError as exc:
        raise PrintError(f"{host}:{port} — {exc}") from exc
    return f"sent {len(data)} bytes to {host}:{port}"


def print_folder(data, folder, name):
    target = Path(folder).expanduser()
    target.mkdir(parents=True, exist_ok=True)
    path = target / name
    path.write_bytes(data)
    return f"wrote {path}"


# --- dispatch ----------------------------------------------------------------

def send(data, config, filename="label.zpl"):
    """Print `data`, choosing a backend from `config`.

    `data` is bytes rather than a string throughout: ZPL is sent to the printer
    as it is, and going through str risks a stray encoding step turning ^ into
    something else.
    """
    backend = config.get("backend", "auto")
    if backend == "auto":
        backend = "winspool" if IS_WINDOWS else "folder"

    if backend == "winspool":
        printer = config.get("printer")
        if not printer:
            found = [p for p in list_windows_printers()
                     if "zebra" in p.lower() or "zt2" in p.lower()]
            if not found:
                raise PrintError(
                    "No printer configured and none with 'Zebra' in its name "
                    "was found. Pick one on the settings screen.")
            printer = found[0]
        return print_winspool(data, printer)
    if backend == "share":
        return print_share(data, config.get("share", "ZEBRA"))
    if backend == "tcp":
        return print_tcp(data, config.get("host", ""),
                         int(config.get("port", 9100)))
    if backend == "folder":
        return print_folder(data, config.get("folder", "printed"), filename)
    raise PrintError(f"Unknown backend {backend!r}.")
