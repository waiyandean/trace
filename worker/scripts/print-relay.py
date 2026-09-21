#!/usr/bin/env python3
"""A tiny HTTP-to-9100 relay, for goods-in.js to print a case label the
moment a line is added.

    python3 print-relay.py --printer 192.168.0.166

For it to survive a reboot or a closed terminal window on the kitchen
laptop, `install-relay-service.bat` in this same folder wraps it as an
actual Windows service instead.

This also relays the frozen-ramen box-seal label to a USB-attached Brother
QL-600, via --brother-printer and POST /print-seal -- see brother_seal.py in
this same folder for why that route renders and prints differently from the
Zebra's byte-blind /print (the QL-600 doesn't speak ZPL and has no network
port to forward bytes to).

Why this exists rather than reusing labels/gui: a browser has no way to open
a raw TCP socket (PLAN.md, "is it possible to host this on GitHub Pages" —
no; fetch/XHR only speak HTTP, and nothing else is exposed to page script).
Something with real socket access has to sit between the page and the
printer's port 9100. labels/gui already has exactly that in printers.py's
print_tcp — but Dean asked (2026-09-16) for this auto-print path to stay
separate from that tool rather than share it, so this is a second, much
smaller one: no catalog, no rendering, no settings screen. It takes ZPL
somebody else already built and gets it to the printer, nothing more.

Deliberately stdlib only, the same reasoning labels/gui gives for it: this
runs on whatever kitchen machine is around, which is not a machine anybody
should have to `pip install` onto.
"""
import argparse
import http.server
import json
import os
import signal
import socket
import sys
from datetime import datetime, timezone


def _stamp():
    return datetime.now(timezone.utc).strftime('%H:%M:%S')


class Handler(http.server.BaseHTTPRequestHandler):
    printer_host = None
    printer_port = 9100
    brother_printer = None

    def log_message(self, fmt, *args):
        # The default log line has no timestamp precision worth reading and
        # no indication of what actually happened; _log below replaces it.
        pass

    def _log(self, message):
        print(f'[{_stamp()}] {self.client_address[0]} — {message}', flush=True)

    def _cors(self):
        # No password, same as labels/gui's network mode and for the same
        # reason: this is a kitchen-LAN tool, not a public one. Anyone on
        # that network can already reach the printer directly on 9100 —
        # this relay adds convenience, not a new exposure.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'content-type')

    def _json(self, status, body):
        import json
        payload = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {
                'ok': True,
                'printer': f'{self.printer_host}:{self.printer_port}',
                'brother_printer': self.brother_printer,
            })
        return self._json(404, {'ok': False, 'error': 'nothing here but POST /print, POST /print-seal and GET /health'})

    def do_POST(self):
        if self.path == '/print':
            return self._print_zebra()
        if self.path == '/print-seal':
            return self._print_seal()
        return self._json(404, {'ok': False, 'error': 'unknown path, use POST /print or POST /print-seal'})

    def _print_zebra(self):
        length = int(self.headers.get('Content-Length', 0))
        if not length:
            self._log('refused: empty body')
            return self._json(400, {'ok': False, 'error': 'empty body — nothing to print'})
        data = self.rfile.read(length)

        try:
            with socket.create_connection((self.printer_host, self.printer_port), timeout=5) as sock:
                sock.sendall(data)
        except OSError as exc:
            self._log(f'refused: {self.printer_host}:{self.printer_port} — {exc}')
            return self._json(502, {
                'ok': False,
                'error': f'could not reach the printer at {self.printer_host}:{self.printer_port} — {exc}',
            })

        self._log(f'sent {len(data)} bytes to {self.printer_host}:{self.printer_port}')
        return self._json(200, {'ok': True, 'bytes': len(data)})

    def _print_seal(self):
        if not self.brother_printer:
            return self._json(400, {'ok': False, 'error': 'no --brother-printer configured on this relay'})

        length = int(self.headers.get('Content-Length', 0))
        if not length:
            self._log('refused: empty body')
            return self._json(400, {'ok': False, 'error': 'empty body — nothing to print'})
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            return self._json(400, {'ok': False, 'error': f'body was not valid JSON — {exc}'})

        # Imported here, not at module load, so this file still runs (and the
        # Zebra route still works) on a non-Windows machine, or one with no
        # QL-600 configured -- brother_seal.py's ctypes calls only resolve on
        # Windows.
        try:
            import brother_seal
        except Exception as exc:  # noqa: BLE001 -- report it, don't crash the relay
            self._log(f'refused: brother_seal unavailable — {exc}')
            return self._json(500, {'ok': False, 'error': f'the Brother seal printer is not available on this machine: {exc}'})

        # Optional, defaulting to one -- batches.js's automatic pack-out print
        # never sends it, and gets the same single copy as before. The
        # /labels page's Copies field does send it, same range as the ZPL
        # routes (1-200).
        try:
            quantity = int(payload.get('quantity', 1))
        except (TypeError, ValueError):
            quantity = 1
        quantity = max(1, min(200, quantity))

        for _ in range(quantity):
            try:
                brother_seal.render_and_print(self.brother_printer, payload)
            except brother_seal.PrintError as exc:
                self._log(f'refused: {self.brother_printer} — {exc}')
                return self._json(502, {'ok': False, 'error': str(exc)})

        self._log(f'printed {quantity}x box seal for {payload.get("name")!r} to {self.brother_printer}')
        return self._json(200, {'ok': True})


# A restart with no traceback in the log could so far mean anything: Ctrl+C
# at a console, NSSM (or Windows) stopping the service, or the process being
# killed outright. Only the first two leave Python any chance to run this
# handler at all -- a hard kill (TerminateProcess, a crash-looping antivirus,
# power loss) skips it entirely, and a run that just stops appearing in the
# log with no matching "stopped" line before the next "listening" one is the
# signature of that, not of anything caught here. Naming which signal fired
# at least rules in or out "something asked it to stop" against "someone hit
# Ctrl+C interactively" the next time this happens.
def _handle_stop(signum, _frame):
    names = getattr(signal, 'Signals', None)
    label = names(signum).name if names else str(signum)
    print(f'[{_stamp()}] stopped (pid {os.getpid()}) — received {label}', flush=True)
    raise SystemExit(0)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--printer', required=True, help='the ZT231\'s IP address, e.g. 192.168.0.166')
    parser.add_argument('--printer-port', type=int, default=9100)
    parser.add_argument('--brother-printer',
                         help='the Windows printer name the QL-600 is installed as, for the box-seal route. '
                              'Omit to leave POST /print-seal disabled.')
    parser.add_argument('--port', type=int, default=8643, help='port this relay listens on')
    parser.add_argument('--local', action='store_true',
                         help='bind 127.0.0.1 only — for testing from this machine, not from an iPad')
    args = parser.parse_args()

    Handler.printer_host = args.printer
    Handler.printer_port = args.printer_port
    Handler.brother_printer = args.brother_printer

    host = '127.0.0.1' if args.local else '0.0.0.0'
    server = http.server.ThreadingHTTPServer((host, args.port), Handler)

    # SIGBREAK is what NSSM (and the Windows Service Control Manager through
    # it) sends to ask a console app to stop; SIGINT is a Ctrl+C typed at an
    # interactive prompt. Windows doesn't have SIGBREAK's counterpart on
    # other platforms, hence the getattr rather than a bare name.
    signal.signal(signal.SIGINT, _handle_stop)
    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, _handle_stop)

    print(f'[{_stamp()}] print-relay (pid {os.getpid()}) — listening on :{args.port}, forwarding to {args.printer}:{args.printer_port}', flush=True)
    if not args.local:
        print('  reachable from anything on this network. There is no password on it.')
    print('  POST /print with raw ZPL as the body. GET /health to check the printer address.')
    if args.brother_printer:
        print(f'  POST /print-seal with JSON for the box seal, printed to {args.brother_printer!r}.')
    else:
        print('  POST /print-seal is disabled — pass --brother-printer to enable it.')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        # Only reachable if a Ctrl+C-equivalent arrived before the signal
        # handlers above were installed, or on a platform without SIGBREAK --
        # _handle_stop already logs and exits for the normal case.
        print(f'[{_stamp()}] stopped (pid {os.getpid()}) — KeyboardInterrupt', flush=True)
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- log it before NSSM's restart hides it
        print(f'[{_stamp()}] crashed (pid {os.getpid()}) — {exc!r}', flush=True)
        raise


if __name__ == '__main__':
    main()
