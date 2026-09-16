#!/usr/bin/env python3
"""A tiny HTTP-to-9100 relay, for goods-in.js to print a case label the
moment a line is added.

    python3 print-relay.py --printer 192.168.0.166

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
import socket
import sys
from datetime import datetime, timezone


class Handler(http.server.BaseHTTPRequestHandler):
    printer_host = None
    printer_port = 9100

    def log_message(self, fmt, *args):
        # The default log line has no timestamp precision worth reading and
        # no indication of what actually happened; _log below replaces it.
        pass

    def _log(self, message):
        stamp = datetime.now(timezone.utc).strftime('%H:%M:%S')
        print(f'[{stamp}] {self.client_address[0]} — {message}', flush=True)

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
                'ok': True, 'printer': f'{self.printer_host}:{self.printer_port}',
            })
        return self._json(404, {'ok': False, 'error': 'nothing here but POST /print and GET /health'})

    def do_POST(self):
        if self.path != '/print':
            return self._json(404, {'ok': False, 'error': 'unknown path, use POST /print'})

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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--printer', required=True, help='the ZT231\'s IP address, e.g. 192.168.0.166')
    parser.add_argument('--printer-port', type=int, default=9100)
    parser.add_argument('--port', type=int, default=8643, help='port this relay listens on')
    parser.add_argument('--local', action='store_true',
                         help='bind 127.0.0.1 only — for testing from this machine, not from an iPad')
    args = parser.parse_args()

    Handler.printer_host = args.printer
    Handler.printer_port = args.printer_port

    host = '127.0.0.1' if args.local else '0.0.0.0'
    server = http.server.ThreadingHTTPServer((host, args.port), Handler)

    print(f'print-relay — listening on :{args.port}, forwarding to {args.printer}:{args.printer_port}')
    if not args.local:
        print('  reachable from anything on this network. There is no password on it.')
    print('  POST /print with raw ZPL as the body. GET /health to check the printer address.')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
        sys.exit(0)


if __name__ == '__main__':
    main()
