#!/usr/bin/env python3
"""A local web GUI for printing labels, for use until trace generates them.

Runs on the machine the printer is attached to. Nothing here talks to D1 or to
the Worker: the catalog is baked into `catalog.json` at build time, so the tool
works with the network down, which is the condition it most needs to work in.

    python server.py            # then open http://localhost:8642

Standard library only, deliberately. The machine this runs on is a kitchen
Windows laptop that somebody has to be able to set up again from nothing, and
"install Python, run this file" is a setup that survives that.

What it does not do: lot codes. Lots belong to the trace ledger, which is not
built yet, and a printed code that resolves to nothing is worse than no code.
See ../README.md and ../../PLAN.md.
"""
import base64
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import printers
import zpl

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CONFIG_PATH = HERE / "config.json"
LOG_PATH = HERE / "print-log.jsonl"
PORT = int(os.environ.get("TRACE_LABELS_PORT", "8642"))

LABELARY = "http://api.labelary.com/v1/printers/8dpmm/labels/4x2/0/"

TYPES = [
    {"id": "goods-in", "name": "Goods In",
     "blurb": "Stuck on a delivery as it comes through the door.",
     "source": "ingredient"},
    {"id": "date-opened", "name": "Date Opened",
     "blurb": "Stuck on a pack when it is opened or decanted.",
     "source": "opening"},
    {"id": "packet", "name": "Product Packet",
     "blurb": "The pouch or tub a finished product goes out in.",
     "source": "product"},
    {"id": "box", "name": "Product Box",
     "blurb": "The case the packets are shipped in.",
     "source": "product"},
]

DEFAULT_CONFIG = {
    "backend": "auto",
    "printer": "",
    "share": "ZEBRA",
    "host": "",
    "port": 9100,
    "folder": str(HERE / "printed"),
    "preview": True,
}


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_config():
    config = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        config.update(load_json(CONFIG_PATH))
    return config


def write_config(config):
    merged = read_config()
    merged.update({k: v for k, v in config.items() if k in DEFAULT_CONFIG})
    CONFIG_PATH.write_text(json.dumps(merged, indent=1) + "\n", encoding="utf-8")
    return merged


def uk(iso):
    """An ISO date from a date input, as the dd/mm/yyyy the labels print.

    Anything that is not an ISO date is passed through untouched, so a field
    somebody has typed by hand still reaches the label.
    """
    if not iso:
        return ""
    try:
        return datetime.strptime(iso, "%Y-%m-%d").strftime("%d/%m/%Y")
    except ValueError:
        return iso


def field(key, label, value="", *, kind="text", editable=True,
          options=None, hint="", missing=False):
    """One row of the form.

    `missing` marks a value the catalog should hold but does not. Those fields
    are editable so a label can still be printed today, and are shown as a gap
    rather than as an ordinary blank, because the fix is to record the answer
    rather than to type it again every time.
    """
    return {"key": key, "label": label, "value": value, "kind": kind,
            "editable": editable, "options": options or [], "hint": hint,
            "missing": missing}


class Data:
    """The catalog and the hand-maintained gaps, reloaded when they change."""

    def __init__(self):
        self.stamp = None
        self.reload()

    def _stamp(self):
        return tuple((HERE / n).stat().st_mtime
                     for n in ("catalog.json", "label-data.json"))

    def reload(self):
        self.catalog = load_json(HERE / "catalog.json")
        self.extra = load_json(HERE / "label-data.json")
        self.items = {i["id"]: i for i in self.catalog["items"]}
        self.stamp = self._stamp()

    def fresh(self):
        if self._stamp() != self.stamp:
            self.reload()
        return self

    def listing(self, type_id):
        """The items a given label type applies to."""
        source = next(t["source"] for t in TYPES if t["id"] == type_id)
        out = []
        for item in self.catalog["items"]:
            if source == "ingredient" and item["kind"] != "ingredient":
                continue
            if source == "product" and item["kind"] != "product":
                continue
            # Some catalog rows are real stock that simply never gets a label
            # of this kind printed. They stay active in the catalog -- this is
            # a statement about labelling, not about whether the kitchen holds
            # the item -- and are named in label-data.json rather than filtered
            # by a rule, so that adding one is a decision somebody recorded.
            if item["name"] in self.extra.get("not_labelled", {}):
                continue
            # Only the fifteen ingredients that are used a bit at a time get a
            # Date Opened label. A pack that is never partly used has nothing
            # to record, and offering one invites labelling that says nothing.
            if source == "opening" and (
                    item["kind"] != "ingredient"
                    or item["opening_rule"] in (None, "whole_pack")):
                continue
            out.append({
                "id": item["id"],
                "name": self.label_name(item, type_id),
                "detail": self.detail(item, type_id),
                "incomplete": bool(self.gaps(item, type_id)),
            })
        return out

    def label_name(self, item, type_id):
        if type_id in ("packet", "box"):
            product = self.extra.get("products", {}).get(item["name"], {})
            return product.get("label_name") or item["name"]
        return item["name"]

    def detail(self, item, type_id):
        if type_id == "goods-in":
            return ", ".join(item["suppliers"]) or "no supplier recorded"
        if type_id == "date-opened":
            days = item["days_after_opening"]
            return f"{days} days once opened" if days else "no period recorded"
        product = self.extra.get("products", {}).get(item["name"], {})
        variant = product.get("box" if type_id == "box" else "packet", {})
        return variant.get("qty") or "pack size not recorded"

    def gaps(self, item, type_id):
        """Which values this label needs that nothing has recorded yet."""
        gaps = []
        if not self.extra.get("allergens", {}).get(item["name"]):
            gaps.append("allergens")
        if type_id in ("packet", "box"):
            product = self.extra.get("products", {}).get(item["name"], {})
            variant = product.get("box" if type_id == "box" else "packet", {})
            # A variant that is sold without a SKU is a decision, not a gap.
            if not variant.get("sku") and not variant.get("no_sku"):
                gaps.append("sku")
            if not variant.get("qty"):
                gaps.append("qty")
            if product.get("health_mark") is None:
                gaps.append("health mark")
        else:
            key = "storage_opened" if type_id == "date-opened" else "storage_unopened"
            if not item[key]:
                gaps.append("storage")
        return gaps

    def form(self, type_id, item_id):
        """The editable form for one item and one label type.

        Batch, the dates, and the quantity are always editable, because they
        change on every print and no catalog will ever hold them. Everything
        else is editable only where nothing has recorded it, so a field that is
        open is a signal that something needs filling in rather than an
        invitation to retype what is already known.
        """
        item = self.items[item_id]
        today = date.today().isoformat()
        allergens = self.extra.get("allergens", {}).get(item["name"], "")
        fields = []

        if type_id == "goods-in":
            fields += [
                field("name", "Ingredient", item["name"], editable=False),
                field("storage", "Storage", item["storage_unopened"] or "",
                      kind="select", editable=not item["storage_unopened"],
                      options=["ambient", "chill", "freezer"],
                      missing=not item["storage_unopened"],
                      hint="Prints as the banner in the top right."),
                field("use_by", "Use by", "", kind="date",
                      hint="Off the supplier's own box. It always wins over "
                           "anything the catalog would work out."),
                field("batch", "Batch number", "",
                      hint="As printed on the delivery."),
                field("supplier", "Supplier",
                      item["suppliers"][0] if item["suppliers"] else "",
                      kind="select" if len(item["suppliers"]) > 1 else "text",
                      editable=len(item["suppliers"]) != 1,
                      options=item["suppliers"],
                      missing=not item["suppliers"]),
                field("delivered", "Delivered", today, kind="date"),
                field("allergens", "Allergens", allergens,
                      missing=not allergens,
                      hint="Nothing in the catalog records these yet. Fill "
                           "label-data.json to stop retyping them."),
            ]
        elif type_id == "date-opened":
            days = item["days_after_opening"]
            use_by = ((date.today() + timedelta(days=days)).isoformat()
                      if days else "")
            fields += [
                field("name", "Ingredient", item["name"], editable=False),
                field("storage_opened", "Storage once opened",
                      item["storage_opened"] or "", kind="select",
                      editable=not item["storage_opened"],
                      options=["ambient", "chill", "freezer"],
                      missing=not item["storage_opened"],
                      hint="Sets both the banner and the instruction at the foot."),
                field("opened", "Opened", today, kind="date"),
                field("use_by", "Use by", use_by, kind="date",
                      hint=(f"{days} days from opening, the kitchen's rule for "
                            f"this item. The pack's own date wins if it is "
                            f"sooner." if days else "")),
                field("batch", "Batch number", ""),
                field("allergens", "Allergens", allergens, missing=not allergens),
            ]
        else:
            product = self.extra.get("products", {}).get(item["name"], {})
            variant = product.get("box" if type_id == "box" else "packet", {})
            mark = product.get("health_mark")
            fields += [
                # The label prints the catalog name. Where a product is named
                # differently on its packaging, a label_name in
                # label-data.json says so; there is nothing to type here.
                field("name", "Product",
                      product.get("label_name") or item["name"],
                      editable=False),
                field("use_by", "Use by", "", kind="date"),
                field("batch", "Batch code", "",
                      hint="Also what the QR carries."),
                field("packed", "Packed", today, kind="date"),
                field("qty", "Quantity", variant.get("qty", ""),
                      editable=not variant.get("qty"),
                      missing=not variant.get("qty"),
                      hint="What one pack holds, e.g. 1.8 Litres."
                           if type_id == "packet" else
                           "What one case holds, e.g. 8 x 1.8 Litres."),
                field("sku", "Customer SKU", variant.get("sku", ""),
                      editable=not variant.get("sku") and not variant.get("no_sku"),
                      missing=not variant.get("sku") and not variant.get("no_sku"),
                      hint="Sold without a SKU." if variant.get("no_sku") else ""),
                field("health_mark", "Health mark",
                      "yes" if mark else "no", kind="select",
                      editable=mark is None, options=["yes", "no"],
                      missing=mark is None,
                      hint="Follows animal origin. Nobody has decided this "
                           "one yet." if mark is None else ""),
                field("allergens", "Allergens",
                      allergens, missing=not allergens),
            ]
            # Only shown where the matrix names a cross-contact allergen. With
            # nothing to name, the label falls back to the generic line and
            # there is no value here to show or to edit.
            may = self.extra.get("may_contain", {}).get(item["name"], "")
            if may:
                fields.append(field("may_contain", "May contain", may,
                                    editable=False,
                                    hint="From the allergen matrix. Replaces "
                                         "the generic line at the foot."))
        return {"type": type_id, "item": item_id,
                "title": self.label_name(item, type_id),
                "gaps": self.gaps(item, type_id), "fields": fields}


def build(data, type_id, item_id, values, quantity):
    """Turn form values into ZPL."""
    item = data.items[item_id]
    if type_id == "goods-in":
        return zpl.goods_in(
            name=values.get("name") or item["name"],
            use_by=uk(values.get("use_by")),
            batch=values.get("batch", ""),
            supplier=values.get("supplier", ""),
            delivered=uk(values.get("delivered")),
            allergens=values.get("allergens", ""),
            storage=values.get("storage") or item["storage_unopened"],
            quantity=quantity)
    if type_id == "date-opened":
        return zpl.date_opened(
            name=values.get("name") or item["name"],
            opened=uk(values.get("opened")),
            use_by=uk(values.get("use_by")),
            batch=values.get("batch", ""),
            allergens=values.get("allergens", ""),
            storage_opened=values.get("storage_opened") or item["storage_opened"],
            quantity=quantity)
    return zpl.product(
        name=values.get("name") or item["name"],
        use_by=uk(values.get("use_by")),
        batch=values.get("batch", ""),
        packed=uk(values.get("packed")),
        qty=values.get("qty", ""),
        sku=values.get("sku", ""),
        allergens=values.get("allergens", ""),
        may_contain=values.get("may_contain", ""),
        producer=data.extra.get("producer", ""),
        health_mark=values.get("health_mark") == "yes",
        hm_country=data.extra.get("health_mark_country", "GB"),
        hm_code=data.extra.get("health_mark_code", ""),
        is_case=type_id == "box",
        quantity=quantity)


def render_png(source):
    """A real render of the label, through Labelary's ZPL interpreter.

    Labelary starts from clean printer state, so it will not reproduce anything
    caused by a setting left behind on the printer itself. It also needs the
    internet, and this machine may not have it, so a failure here is reported
    rather than raised: a preview is a convenience and printing does not depend
    on it.
    """
    request = urllib.request.Request(
        LABELARY, data=source.encode("utf-8"),
        headers={"Accept": "image/png", "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return base64.b64encode(response.read()).decode("ascii")


def log_print(entry):
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


class Handler(BaseHTTPRequestHandler):
    data = None
    server_version = "trace-labels"

    def log_message(self, fmt, *args):
        # The default logs every static asset, which buries the one line that
        # matters -- what was printed.
        if "/api/print" in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    # -- plumbing ------------------------------------------------------------

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        types = {".html": "text/html; charset=utf-8", ".css": "text/css",
                 ".js": "text/javascript", ".svg": "image/svg+xml"}
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", types.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    # -- routes --------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?")[0]
        data = self.data.fresh()

        if path in ("/", "/index.html"):
            return self.send_file(STATIC / "index.html")
        if path.startswith("/static/"):
            target = (STATIC / path[len("/static/"):]).resolve()
            if STATIC.resolve() in target.parents and target.is_file():
                return self.send_file(target)
            return self.send_json({"error": "not found"}, 404)
        if path == "/api/bootstrap":
            config = read_config()
            return self.send_json({
                "types": TYPES,
                "config": config,
                "backend": ("winspool" if config["backend"] == "auto"
                            and printers.IS_WINDOWS else
                            "folder" if config["backend"] == "auto"
                            else config["backend"]),
                "printers": printers.list_windows_printers(),
                "windows": printers.IS_WINDOWS,
            })
        if match := re.fullmatch(r"/api/items/([\w-]+)", path):
            return self.send_json({"items": data.listing(match.group(1))})
        if match := re.fullmatch(r"/api/form/([\w-]+)/([\w:%-]+)", path):
            item_id = urllib.parse.unquote(match.group(2))
            if item_id not in data.items:
                return self.send_json({"error": "unknown item"}, 404)
            return self.send_json(data.form(match.group(1), item_id))
        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        data = self.data.fresh()
        try:
            payload = self.body()
        except ValueError:
            return self.send_json({"error": "bad request"}, 400)

        if path == "/api/render":
            return self._render(data, payload)
        if path == "/api/print":
            return self._print(data, payload)
        if path == "/api/config":
            return self.send_json({"config": write_config(payload)})
        return self.send_json({"error": "not found"}, 404)

    def _render(self, data, payload):
        try:
            source, warnings = build(
                data, payload["type"], payload["item"],
                payload.get("values", {}), int(payload.get("quantity", 1) or 1))
        except (KeyError, ValueError) as exc:
            return self.send_json({"error": str(exc)}, 400)

        png, error = None, ""
        if read_config().get("preview", True):
            try:
                png = render_png(source)
            except (urllib.error.URLError, OSError, TimeoutError) as exc:
                error = (f"No preview: {exc}. The label itself is unaffected "
                         f"-- rendering needs the internet, printing does not.")
        return self.send_json({"zpl": source, "warnings": warnings,
                               "png": png, "preview_error": error})

    def _print(self, data, payload):
        quantity = int(payload.get("quantity", 1) or 1)
        if not 1 <= quantity <= 200:
            return self.send_json(
                {"error": "Quantity has to be between 1 and 200."}, 400)
        try:
            source, warnings = build(data, payload["type"], payload["item"],
                                     payload.get("values", {}), quantity)
        except (KeyError, ValueError) as exc:
            return self.send_json({"error": str(exc)}, 400)

        config = read_config()
        try:
            message = printers.send(
                source.encode("utf-8"), config,
                filename=f"{payload['type']}-{quantity}.zpl")
        except printers.PrintError as exc:
            return self.send_json({"error": str(exc)}, 500)

        # What came out of the printer, kept. It is not the archive the plan
        # describes -- there are no lots to tie it to yet -- but it answers
        # "how many of those did we print, and when", which is the question
        # asked the moment a roll of labels goes missing.
        log_print({"at": datetime.now().isoformat(timespec="seconds"),
                   "type": payload["type"], "item": payload["item"],
                   "quantity": quantity, "values": payload.get("values", {}),
                   "result": message})
        return self.send_json({"ok": True, "message": message,
                               "warnings": warnings})


def main():
    Handler.data = Data()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"trace labels — {url}")
    print(f"  printing via: {read_config()['backend']}")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
