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
import socket
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
# The kitchen's catalog photographs, 320px, named by item id. In the
# repository they live with the Worker's assets rather than being copied here:
# two copies of two megabytes of the same JPEGs would drift apart the first
# time one is re-imported. A local `static/photos` wins if it exists, which is
# what the packaged copy at the printer carries.
#
# That packaged copy sits wherever somebody put it -- C:\label-gui, with one
# parent -- so the repository path is worked out only when there is enough
# path to work it out from. Reaching two levels up unconditionally is an
# IndexError on a shallow path, and the tool would not start at all.
PHOTO_DIRS = [STATIC / "photos"]
if len(HERE.parents) >= 2:
    PHOTO_DIRS.append(HERE.parents[1] / "worker" / "public" / "photos")
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
    # No catalog behind this one, so it has no list to pick from and the tile
    # opens the label itself.
    {"id": "notice", "name": "Notice",
     "blurb": "Anything else: a warning, a note, a sign. Big words, centred.",
     "source": "free"},
]

DEFAULT_CONFIG = {
    "backend": "auto",
    "printer": "",
    "share": "ZEBRA",
    "host": "",
    "port": 9100,
    "folder": str(HERE / "printed"),
    "preview": True,
    # "local" binds 127.0.0.1 and only this machine can reach the tool.
    # "network" binds every interface, so anything on the kitchen's wifi can
    # open it -- an iPad at the goods-in door driving the printer that is
    # plugged into this laptop. There is no password on it: whoever can reach
    # it can print. On a kitchen LAN the worst case is wasted labels, but it
    # is a deliberate choice rather than the default.
    "listen": "local",
}


def photo_path(item_id):
    for folder in PHOTO_DIRS:
        candidate = folder / f"{item_id}.jpg"
        if candidate.is_file():
            return candidate
    return None


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


def lan_addresses():
    """This machine's addresses on the network, for telling people where to go.

    Asking the operating system which address it would use to reach the
    outside world is the only reliable way to get the one that matters; the
    hostname often resolves to a loopback address instead. Nothing is sent.
    """
    found = []
    for probe in ("8.8.8.8", "192.168.1.1"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(0.2)
                sock.connect((probe, 80))
                address = sock.getsockname()[0]
                if address not in found and not address.startswith("127."):
                    found.append(address)
        except OSError:
            continue
    return found


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


def ddmmyy(iso):
    """An ISO date as the six digits a goods-in batch number uses."""
    try:
        return datetime.strptime(iso, "%Y-%m-%d").strftime("%d%m%y")
    except (ValueError, TypeError):
        return ""


# The suffix a production batch code carries after the day and month. It marks
# which line or run the batch came off, and GA is the one this kitchen uses.
BATCH_SUFFIX = "GA"


def batch_code(iso, pot=""):
    """A production batch code: the day and month, the run suffix, then the pot.

    The broths are cooked several batches to a day and each pot is its own
    batch, so the pot number is part of the code rather than a note beside it.
    A product cooked once a day carries no pot number and the code ends at the
    suffix.
    """
    try:
        day = datetime.strptime(iso, "%Y-%m-%d").strftime("%d%m")
    except (ValueError, TypeError):
        return ""
    return f"{day}{BATCH_SUFFIX}{pot}"


def months_on(iso, months):
    """`months` after `iso`, moved to the first of that month.

    Shelf life on a finished product is counted in whole months and always
    lands on a first: a batch packed on the 23rd of January with six months on
    it is used by the 1st of July, not the 23rd. Rounding down to the start of
    the month is the conservative direction -- it can only shorten the life,
    never extend it past what was intended.
    """
    try:
        packed = datetime.strptime(iso, "%Y-%m-%d")
    except (ValueError, TypeError):
        return ""
    total = packed.year * 12 + (packed.month - 1) + months
    return date(total // 12, total % 12 + 1, 1).isoformat()


def field(key, label, value="", *, kind="text", editable=True,
          options=None, hint="", missing=False, follows=None, derive=None):
    """One row of the form.

    `missing` marks a value the catalog should hold but does not. Those fields
    are editable so a label can still be printed today, and are shown as a gap
    rather than as an ordinary blank, because the fix is to record the answer
    rather than to type it again every time.
    """
    return {"key": key, "label": label, "value": value, "kind": kind,
            "editable": editable, "options": options or [], "hint": hint,
            "missing": missing, "follows": follows, "derive": derive}


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

    STORAGE_LABELS = {"chill": "Chilled", "freezer": "Frozen",
                      "ambient": "Ambient"}

    def listing(self, type_id, _unused=None):
        """The items a given label type applies to, in the groups they are
        picked from.

        Ingredients are grouped by supplier and then by storage, which is the
        order the two facts are needed in. A delivery is one van from one
        supplier, so that narrows sixty things to twenty-odd; within it, what
        separates one row from the next is where the goods are going, because
        that is what happens to them next and it is what a wrong answer costs.

        An ingredient bought from both suppliers appears under both, since at
        the door it genuinely could be either. Storage sections do not overlap.
        """
        source = next(t["source"] for t in TYPES if t["id"] == type_id)
        rows = []
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
            rows.append({
                "id": item["id"],
                "name": self.label_name(item, type_id),
                "detail": self.detail(item, type_id),
                "incomplete": bool(self.gaps(item, type_id)),
                "photo": photo_path(item["id"]) is not None,
                "suppliers": item["suppliers"],
            })

        if source == "product":
            return self._by_category(rows)

        groups = []
        for supplier in self.catalog["suppliers"] + [None]:
            # A trailing None stands for the ingredients nobody has recorded a
            # supplier for; they would otherwise vanish from a screen that only
            # draws the suppliers it knows about.
            members = ([r for r in rows if supplier in r["suppliers"]] if supplier
                       else [r for r in rows if not r["suppliers"]])
            if not members:
                continue
            if type_id == "goods-in":
                # Inside a supplier's own group its name is on the heading, so
                # repeating it on every row says nothing. What is worth saying
                # is that an item also comes from the other supplier, which is
                # why the same row appears twice on the screen.
                members = [dict(row, detail=(
                    "also " + ", ".join(s for s in row["suppliers"] if s != supplier)
                    if len(row["suppliers"]) > 1 else "")) for row in members]
            groups.append({
                "name": supplier or "No supplier recorded",
                "sections": self._by_storage(members, type_id),
            })
        return groups

    def _by_category(self, rows):
        """Products under the headings the kitchen thinks of them in.

        The catalog has one flat kind, `product`, which covers a two-litre tub
        of sauce and a frozen retail ramen alike. Twenty-five of those in one
        alphabetical run is a list to search rather than a list to pick from.
        """
        categories = self.extra.get("product_categories", [])
        of = {r["id"]: self.extra.get("products", {})
              .get(self.items[r["id"]]["name"], {}).get("category")
              for r in rows}
        groups = []
        for category in categories:
            members = [r for r in rows if of[r["id"]] == category]
            if members:
                groups.append({"name": category,
                               "sections": [{"name": "", "items": members}]})
        # A product nobody has placed yet gets its own heading at the end
        # rather than being folded into the largest category, where it would
        # look deliberate.
        loose = [r for r in rows if of[r["id"]] not in categories]
        if loose:
            groups.append({"name": "Not categorised",
                           "sections": [{"name": "", "items": loose}]})
        return groups

    def _by_storage(self, rows, type_id):
        """Split one supplier's rows by where the goods are kept.

        Goods In uses the unopened requirement, which is where a delivery is
        put away. Date Opened uses the after-opening one, which is the whole
        point of that label: several things sit on an ambient shelf unopened
        and have to be refrigerated once they are not.
        """
        key = "storage_opened" if type_id == "date-opened" else "storage_unopened"
        sections = []
        for value, label in self.STORAGE_LABELS.items():
            members = [r for r in rows if self.items[r["id"]][key] == value]
            if members:
                sections.append({"name": label, "items": members})
        # Null means nobody has determined it, not that there is no
        # requirement, so these are named rather than filed under Ambient.
        loose = [r for r in rows if not self.items[r["id"]][key]]
        if loose:
            sections.append({"name": "Storage not recorded", "items": loose})
        return sections

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
        if variant.get("qty"):
            return variant["qty"]
        # A pack size nobody states is not a pack size nobody has got round to.
        return "" if variant.get("no_qty") else "pack size not recorded"

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
            # A variant with no pack size stated on its label is a decision,
            # not a gap, the same as one sold without a SKU.
            if not variant.get("qty") and not variant.get("no_qty"):
                gaps.append("qty")
            if product.get("health_mark") is None:
                gaps.append("health mark")
        else:
            key = "storage_opened" if type_id == "date-opened" else "storage_unopened"
            if not item[key]:
                gaps.append("storage")
        return gaps

    def form(self, type_id, item_id):
        if type_id == "notice":
            return {"type": type_id, "item": item_id, "title": "Notice",
                    "gaps": [], "fields": [field(
                        "text", "What it should say", "", kind="lines",
                        hint="Set as large as it will go and centred. Keep it "
                             "short: a label read across a room is a few "
                             "words, not a paragraph.")]}

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
                      hint="Off the supplier's own box, where there is one. "
                           "Left empty, the label says \"See product "
                           "packaging\" rather than printing a blank."),
                # The kitchen's batch number for an intake is the delivery date
                # as six digits, so it follows the Delivered field rather than
                # being typed twice. Typing into it stops it following, because
                # a supplier's own batch code sometimes has to be used instead.
                field("batch", "Batch number", ddmmyy(today),
                      derive="ddmmyy",
                      hint="The delivery date as ddmmyy. Type over it to use "
                           "the supplier's own code instead."),
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
            # Shelf life is counted in whole months from the day a batch is
            # packed. Twelve for the broths, six for everything else (Dean,
            # 2026-09-01); it is held per category rather than per product
            # because that is the level at which it was decided.
            months = 12 if product.get("category") == "Broths" else 6
            pots = self.extra.get("pot_numbers", {})
            uses_pots = product.get("category") in pots.get("categories", [])
            first_pot = "1" if uses_pots else ""
            fields += [
                # The label prints the catalog name. Where a product is named
                # differently on its packaging, a label_name in
                # label-data.json says so; there is nothing to type here.
                field("name", "Product",
                      product.get("label_name") or item["name"],
                      editable=False),
                field("packed", "Packed", today, kind="date",
                      hint="The batch code and the use-by both follow this."),
                field("use_by", "Use by", months_on(today, months), kind="date",
                      derive=f"months:{months}",
                      hint=f"{months} months from packing, on the first of that "
                           f"month. Type over it to set a different date."),
                field("batch", "Batch code", batch_code(today, first_pot),
                      derive="batch",
                      hint="The packing date as ddmm, then the run suffix "
                           f"{BATCH_SUFFIX}"
                           + (", then the pot." if uses_pots else ".")),
                field("qty", "Quantity", variant.get("qty", ""),
                      editable=not variant.get("qty") and not variant.get("no_qty"),
                      missing=not variant.get("qty") and not variant.get("no_qty"),
                      hint="Not stated on this label." if variant.get("no_qty")
                           else "What one pack holds, e.g. 1.8 Litres."
                           if type_id == "packet"
                           else "What one case holds, e.g. 8 x 1.8 Litres."),
                field("sku", "Customer SKU", variant.get("sku", ""),
                      editable=not variant.get("sku") and not variant.get("no_sku"),
                      missing=not variant.get("sku") and not variant.get("no_sku"),
                      hint="Sold without a SKU, so the label carries no QR."
                           if variant.get("no_sku") else "Also what the QR "
                           "carries."),
                field("health_mark", "Health mark",
                      "yes" if mark else "no", kind="select",
                      editable=mark is None, options=["yes", "no"],
                      missing=mark is None,
                      hint="Follows animal origin. Nobody has decided this "
                           "one yet." if mark is None else ""),
                field("allergens", "Allergens",
                      allergens, missing=not allergens),
            ]
            if uses_pots:
                # These are cooked several times a day and every pot is its own
                # batch, so which pot this is has to be picked before printing.
                # It sits directly under the code it changes.
                fields.insert(4, field(
                    "pot", "Pot", first_pot, kind="choice",
                    options=[str(n) for n in
                             range(1, int(pots.get("highest", 8)) + 1)],
                    hint="Which pot this batch came out of. It is the last "
                         "character of the batch code."))
            # Only shown where the matrix names a cross-contact allergen. With
            # nothing to name, the label falls back to the generic line and
            # there is no value here to show or to edit.
            if product.get("barcode"):
                fields.append(field(
                    "barcode", "Barcode", product["barcode"], editable=False,
                    hint="The product's registered EAN-13. It replaces the QR "
                         "on this label -- two symbols on a small label "
                         "invites scanning the wrong one."))
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
    if type_id == "notice":
        return zpl.notice(text=values.get("text", ""), quantity=quantity)
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
        barcode=values.get("barcode", ""),
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
                 ".js": "text/javascript", ".svg": "image/svg+xml",
                 ".jpg": "image/jpeg", ".png": "image/png",
                 ".webmanifest": "application/manifest+json"}
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
            return self.send_json({"groups": data.listing(match.group(1))})
        if match := re.fullmatch(r"/photos/([\w:%-]+)\.jpg", path):
            found = photo_path(urllib.parse.unquote(match.group(1)))
            if not found:
                return self.send_json({"error": "no photograph"}, 404)
            return self.send_file(found)
        if match := re.fullmatch(r"/api/form/([\w-]+)/([\w:%-]+)", path):
            item_id = urllib.parse.unquote(match.group(2))
            if match.group(1) != "notice" and item_id not in data.items:
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
    config = read_config()
    on_network = config.get("listen") == "network"
    server = ThreadingHTTPServer(
        ("0.0.0.0" if on_network else "127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"trace labels — {url}")
    print(f"  printing via: {config['backend']}")
    if on_network:
        for address in lan_addresses():
            print(f"  on the network at: http://{address}:{PORT}")
        print("  anyone who can reach that address can print. There is no "
              "password on it.")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
