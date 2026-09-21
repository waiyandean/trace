"""Unit tests for brother_seal.py's EAN-13 encoder -- the one piece of the
Brother box-seal path with real logic to check, and importable on any OS
since gdi32 is loaded lazily rather than at module import.

Run with: python3 worker/scripts/test_brother_seal.py
"""
import unittest

import brother_seal


class Ean13Tests(unittest.TestCase):
    # Same barcode as worker/src/labels/zpl.test.js's EAN-13 tests and the
    # reference label photo (Hell Ramen, 5070004671211).
    KNOWN = "5070004671211"

    def test_check_digit_matches_the_known_barcode(self):
        self.assertEqual(brother_seal.check_digit(self.KNOWN[:12]), int(self.KNOWN[12]))

    def test_a_bare_twelve_digits_gets_the_check_digit_appended(self):
        digits, _ = brother_seal.ean13_bars(self.KNOWN[:12])
        self.assertEqual(digits, self.KNOWN)

    def test_thirteen_digits_with_a_wrong_check_digit_is_refused(self):
        with self.assertRaisesRegex(brother_seal.PrintError, "wrong check digit"):
            brother_seal.ean13_bars(self.KNOWN[:12] + "9")

    def test_bar_pattern_is_95_modules_with_the_standard_guards(self):
        _, bars = brother_seal.ean13_bars(self.KNOWN)
        self.assertEqual(len(bars), 95)
        self.assertEqual(bars[0:3], "101")       # start guard
        self.assertEqual(bars[45:50], "01010")   # middle guard
        self.assertEqual(bars[92:95], "101")     # end guard

    def test_wrong_digit_count_is_refused_rather_than_silently_truncated(self):
        with self.assertRaisesRegex(brother_seal.PrintError, "not 12 or 13"):
            brother_seal.ean13_bars("123")

    def test_non_digit_characters_are_stripped_before_encoding(self):
        digits, bars = brother_seal.ean13_bars(f"  {self.KNOWN[:6]}-{self.KNOWN[6:12]}  ")
        self.assertEqual(digits, self.KNOWN)
        _, bars_clean = brother_seal.ean13_bars(self.KNOWN)
        self.assertEqual(bars, bars_clean)


if __name__ == "__main__":
    unittest.main()
