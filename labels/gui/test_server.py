import copy
import unittest
from unittest import mock

import server


class LabelWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = server.Data()

    def test_goods_in_rows_carry_the_supplier_group(self):
        rows = {
            (group["name"], item["name"]): item
            for group in self.data.listing("goods-in")
            for section in group["sections"]
            for item in section["items"]
        }
        self.assertEqual(
            rows[("Tazaki", "Ground Bean Sauce")]["supplier"], "Tazaki")
        self.assertEqual(
            rows[("Lynas", "Ground Bean Sauce")]["supplier"], "Lynas")

    def test_selected_supplier_prefills_the_form(self):
        item = next(item for item in self.data.catalog["items"]
                    if item["name"] == "Ground Bean Sauce")
        form = self.data.form("goods-in", item["id"], supplier="Tazaki")
        values = {field["key"]: field["value"] for field in form["fields"]}
        self.assertEqual(values["supplier"], "Tazaki")
        with self.assertRaises(ValueError):
            self.data.form("goods-in", item["id"], supplier="Unknown")

    def test_date_opened_use_by_follows_opened_date(self):
        item = next(item for item in self.data.catalog["items"]
                    if item.get("days_after_opening"))
        form = self.data.form("date-opened", item["id"])
        fields = {field["key"]: field for field in form["fields"]}
        self.assertEqual(
            fields["use_by"]["derive"], f"days:{item['days_after_opening']}")

    def test_recorded_allergens_are_locked_and_server_owned(self):
        item = next(item for item in self.data.catalog["items"]
                    if self.data.extra["allergens"].get(item["name"]))
        form = self.data.form("goods-in", item["id"])
        allergen = next(field for field in form["fields"]
                        if field["key"] == "allergens")
        self.assertFalse(allergen["editable"])
        source, _ = server.build(
            self.data, "goods-in", item["id"],
            {"allergens": "FORGED DECLARATION"}, 1)
        self.assertNotIn("FORGED DECLARATION", source)
        self.assertIn(self.data.extra["allergens"][item["name"]], source)

    def test_missing_allergens_block_preparation(self):
        data = copy.deepcopy(self.data)
        item = next(iter(data.items.values()))
        data.extra["allergens"].pop(item["name"], None)
        with self.assertRaisesRegex(ValueError, "No allergen declaration"):
            server.prepare(data, {
                "type": "goods-in", "item": item["id"],
                "values": {}, "quantity": 1,
            })

    def test_prepared_zpl_has_a_stable_fingerprint(self):
        item = next(item for item in self.data.catalog["items"]
                    if item["kind"] == "ingredient")
        payload = {
            "type": "goods-in", "item": item["id"],
            "values": {"batch": "170926"}, "quantity": 1,
        }
        first = server.prepare(self.data, payload)
        second = server.prepare(self.data, payload)
        changed = server.prepare(self.data, {**payload, "quantity": 2})
        self.assertEqual(first[2], second[2])
        self.assertNotEqual(first[2], changed[2])

    def test_quantity_must_be_a_whole_number_in_range(self):
        item = next(item for item in self.data.catalog["items"]
                    if item["kind"] == "ingredient")
        payload = {"type": "goods-in", "item": item["id"], "values": {}}
        for quantity in (0, 201, 1.5, "", True):
            with self.subTest(quantity=quantity), self.assertRaises(ValueError):
                server.prepare(self.data, {**payload, "quantity": quantity})

    def test_print_requires_the_current_prepared_fingerprint(self):
        item = next(item for item in self.data.catalog["items"]
                    if item["kind"] == "ingredient")
        form = self.data.form("goods-in", item["id"])
        payload = {
            "type": "goods-in", "item": item["id"], "quantity": 1,
            "values": {field["key"]: field["value"]
                       for field in form["fields"]},
        }
        _, _, fingerprint, _ = server.prepare(self.data, payload)
        handler = object.__new__(server.Handler)
        handler.send_json = lambda body, status=200: (body, status)

        with mock.patch("server.printers.send") as send:
            body, status = handler._print(
                self.data, {**payload, "fingerprint": "stale"})
            self.assertEqual(status, 409)
            self.assertIn("changed", body["error"])
            send.assert_not_called()

        with (mock.patch("server.printers.send", return_value="test printer"),
              mock.patch("server.log_print")):
            body, status = handler._print(
                self.data, {**payload, "fingerprint": fingerprint})
            self.assertEqual(status, 200)
            self.assertTrue(body["ok"])

    def test_box_seal_lists_only_frozen_ramen(self):
        for group in self.data.listing("box-seal"):
            for section in group["sections"]:
                for row in section["items"]:
                    product = self.data.extra["products"][
                        self.data.items[row["id"]]["name"]]
                    self.assertEqual(product["category"], "Frozen Ramen")

    def test_box_seal_batch_and_use_by_derive_correctly(self):
        item = next(
            item for item in self.data.catalog["items"]
            if self.data.extra["products"].get(item["name"], {}).get(
                "category") == "Frozen Ramen")
        form = self.data.form("box-seal", item["id"])
        fields = {field["key"]: field for field in form["fields"]}
        self.assertEqual(fields["batch"]["derive"], "batch")
        self.assertEqual(fields["use_by"]["derive"], "years:1")
        today = server.date.today().isoformat()
        self.assertEqual(fields["batch"]["value"], server.batch_code(today))
        self.assertEqual(fields["use_by"]["value"], server.years_on(today, 1))

    def test_box_seal_barcode_and_health_mark_are_never_editable(self):
        item = next(
            item for item in self.data.catalog["items"]
            if self.data.extra["products"].get(item["name"], {}).get(
                "category") == "Frozen Ramen")
        form = self.data.form("box-seal", item["id"])
        fields = {field["key"]: field for field in form["fields"]}
        self.assertFalse(fields["barcode"]["editable"])
        self.assertFalse(fields["health_mark"]["editable"])
        self.assertTrue(fields["barcode"]["value"])

    def test_years_on_falls_back_off_a_leap_day(self):
        self.assertEqual(server.years_on("2028-02-29", 1), "2029-02-28")
        self.assertEqual(server.years_on("2026-06-14", 1), "2027-06-14")

    def test_seal_fingerprint_changes_with_the_form(self):
        item = next(
            item for item in self.data.catalog["items"]
            if self.data.extra["products"].get(item["name"], {}).get(
                "category") == "Frozen Ramen")
        payload = {"item": item["id"], "quantity": 1,
                   "values": {"batch": "1809GA", "use_by": "2027-09-18"}}
        first = server.prepare_seal(self.data, payload)
        second = server.prepare_seal(
            self.data, {**payload, "values": {**payload["values"], "batch": "1909GA"}})
        self.assertEqual(len(first[1]), 64)
        self.assertNotEqual(first[1], second[1])

    def test_seal_payload_locks_barcode_and_health_mark_to_the_catalog(self):
        item = next(
            item for item in self.data.catalog["items"]
            if self.data.extra["products"].get(item["name"], {}).get(
                "category") == "Frozen Ramen")
        product = self.data.extra["products"][item["name"]]
        seal = server.seal_payload(self.data, item["id"], {
            "batch": "1809GA", "use_by": "2027-09-18",
            "barcode": "000000000000", "health_mark": "no",
        })
        self.assertEqual(seal["barcode"], product["barcode"])
        self.assertEqual(seal["healthMark"], bool(product.get("health_mark")))

    def test_seal_print_is_refused_without_a_configured_brother_printer(self):
        item = next(
            item for item in self.data.catalog["items"]
            if self.data.extra["products"].get(item["name"], {}).get(
                "category") == "Frozen Ramen")
        payload = {"item": item["id"], "quantity": 1,
                   "values": {"batch": "1809GA", "use_by": "2027-09-18"}}
        _, fingerprint, _ = server.prepare_seal(self.data, payload)
        handler = object.__new__(server.Handler)
        handler.send_json = lambda body, status=200: (body, status)
        with mock.patch("server.read_config", return_value={"brother_printer": ""}):
            body, status = handler._seal_print(
                self.data, {**payload, "fingerprint": fingerprint})
        self.assertEqual(status, 400)
        self.assertIn("Settings", body["error"])

    def test_every_listed_label_can_be_prepared(self):
        for type_id in ("goods-in", "date-opened", "packet", "box", "dessert"):
            seen = set()
            for group in self.data.listing(type_id):
                for section in group["sections"]:
                    for row in section["items"]:
                        key = (row["id"], row.get("supplier"))
                        if key in seen:
                            continue
                        seen.add(key)
                        form = self.data.form(
                            type_id, row["id"], supplier=row.get("supplier"))
                        values = {field["key"]: field["value"]
                                  for field in form["fields"]}
                        with self.subTest(type=type_id, item=row["name"],
                                          supplier=row.get("supplier")):
                            source, _, fingerprint, quantity = server.prepare(
                                self.data, {"type": type_id, "item": row["id"],
                                            "values": values, "quantity": 1})
                            self.assertTrue(source.startswith("^XA"))
                            self.assertEqual(len(fingerprint), 64)
                            self.assertEqual(quantity, 1)


if __name__ == "__main__":
    unittest.main()
