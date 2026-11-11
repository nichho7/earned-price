# Tests for exam pack 2. MIT License. Never shown to the reviewer.
# test_bug_* tests describe correct behaviour, so each one FAILS on the planted bug it names.
# test_ok_* tests cover code without planted bugs and must pass.
# Run: python3 -m pytest packs/pack-2   (or: python3 -m unittest discover -s packs/pack-2)

import io
import json
import os
import sys
import tempfile
import unittest
from datetime import date
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import stock  # noqa: E402

CATALOG_ROWS = [
    {"sku": "A", "name": "Anvil", "reorder_point": 5, "unit_cost_cents": 1000},
    {"sku": "B", "name": "Bolt", "unit_cost_cents": 5},
]


class TrackedFile(io.StringIO):
    closed_by_caller = False

    def close(self):
        TrackedFile.closed_by_caller = True
        super().close()


class PlantedBugs(unittest.TestCase):
    def test_bug_B1_catalog_file_is_closed(self):
        TrackedFile.closed_by_caller = False
        handle = TrackedFile(json.dumps(CATALOG_ROWS))
        with mock.patch("builtins.open", return_value=handle):
            stock.load_catalog("catalog.json")
        self.assertTrue(TrackedFile.closed_by_caller)

    def test_bug_B2_failed_save_reports_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing_dir = os.path.join(tmp, "no-such-dir", "snap.json")
            self.assertFalse(stock.save_snapshot({"A": 1}, missing_dir))

    def test_bug_B3_write_off_cannot_go_negative(self):
        levels = {"A": 2}
        with self.assertRaises(stock.StockError):
            stock.write_off(levels, "A", 5, "damaged")
        self.assertEqual(levels["A"], 2)

    def test_bug_B4_page_returns_full_page(self):
        levels = {"A": 1, "B": 2, "C": 3, "D": 4}
        self.assertEqual(stock.page(levels, 1, 2), [("A", 1), ("B", 2)])

    def test_bug_B5_lot_expires_after_its_date(self):
        lot = {"lot_id": "L1", "quantity": 1, "expires_on": date(2026, 1, 10)}
        self.assertTrue(stock.is_expired(lot, date(2026, 2, 1)))
        self.assertFalse(stock.is_expired(lot, date(2026, 1, 1)))


class Unplanted(unittest.TestCase):
    def test_ok_load_catalog_parses_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "catalog.json")
            with open(path, "w", encoding="utf-8") as out:
                json.dump(CATALOG_ROWS, out)
            catalog = stock.load_catalog(path)
        self.assertEqual(catalog["B"], {"name": "Bolt", "reorder_point": 0, "unit_cost_cents": 5})

    def test_ok_save_snapshot_writes_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snap.json")
            self.assertTrue(stock.save_snapshot({"A": 1}, path))
            with open(path, encoding="utf-8") as f:
                self.assertEqual(json.load(f), {"A": 1})

    def test_ok_receive_reserve_ship(self):
        levels, reservations = {}, {}
        stock.receive(levels, "A", 10)
        self.assertEqual(stock.reserve(levels, reservations, "o1", "A", 4), 6)
        with self.assertRaises(stock.StockError):
            stock.reserve(levels, reservations, "o2", "A", 7)
        self.assertEqual(stock.ship(levels, reservations, "o1"), 6)
        with self.assertRaises(stock.StockError):
            stock.release(reservations, "o1")

    def test_ok_receive_rejects_non_positive(self):
        with self.assertRaises(stock.StockError):
            stock.receive({}, "A", 0)

    def test_ok_write_off_needs_reason(self):
        with self.assertRaises(stock.StockError):
            stock.write_off({"A": 5}, "A", 1, "")

    def test_ok_reorder_and_alerts(self):
        catalog = {"A": {"name": "Anvil", "reorder_point": 5, "unit_cost_cents": 1000},
                   "B": {"name": "Bolt", "reorder_point": 0, "unit_cost_cents": 5}}
        levels = {"A": 5, "B": 3}
        self.assertEqual(stock.reorder_list(levels, catalog), ["A"])
        self.assertEqual(stock.low_stock_alerts(levels, catalog), ["Anvil (A): 5 left"])
        self.assertEqual(stock.stock_value_cents(levels, catalog), 5015)

    def test_ok_page_count_and_bounds(self):
        self.assertEqual(stock.page_count({"A": 1, "B": 1, "C": 1}, 2), 2)
        with self.assertRaises(stock.StockError):
            stock.page({"A": 1}, 0, 2)

    def test_ok_parse_and_pick_lot(self):
        lots = [stock.parse_lot("L1; A; 5; 2026-03-01"), stock.parse_lot("L2;A;20;2026-02-01")]
        self.assertEqual(lots[0]["expires_on"], date(2026, 3, 1))
        with mock.patch.object(stock, "is_expired", return_value=False):
            self.assertEqual(stock.pick_lot(lots, date(2026, 1, 1), 10), "L2")
            with self.assertRaises(stock.StockError):
                stock.pick_lot(lots, date(2026, 1, 1), 50)

    def test_ok_movement_report_and_merge(self):
        self.assertEqual(stock.movement_report([("A", 5), ("A", -2)]), {"A": {"in": 5, "out": 2}})
        self.assertEqual(stock.merge_levels({"A": 1}, {"A": 2, "B": 1}), {"A": 3, "B": 1})


if __name__ == "__main__":
    unittest.main()
