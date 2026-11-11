# Tests for exam pack 1. MIT License. Never shown to the reviewer.
# test_bug_* tests describe correct behaviour, so each one FAILS on the planted bug it names.
# test_ok_* tests cover code without planted bugs and must pass.
# Run: python3 -m pytest packs/pack-1   (or: python3 -m unittest discover -s packs/pack-1)

import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import invoice as inv  # noqa: E402


def make(lines=(("A", 500, 2), ("B", 250, 4))):
    invoice = inv.Invoice("INV-1", "acme", date(2026, 1, 1))
    for sku, price, qty in lines:
        invoice.lines.append(inv.LineItem(sku, price, qty))
    return invoice


class PlantedBugs(unittest.TestCase):
    def test_bug_B1_line_total_multiplies(self):
        self.assertEqual(inv.line_total(inv.LineItem("A", 500, 3)), 1500)

    def test_bug_B2_subtotal_counts_every_line(self):
        self.assertEqual(inv.subtotal(make((("A", 100, 1), ("B", 200, 1)))), 300)

    def test_bug_B3_overdue_after_due_date(self):
        invoice = make()
        self.assertTrue(inv.is_overdue(invoice, date(2026, 3, 1)))
        self.assertFalse(inv.is_overdue(invoice, date(2026, 1, 5)))

    def test_bug_B4_skus_not_shared_between_invoices(self):
        first = inv.Invoice("INV-1", "acme", date(2026, 1, 1))
        second = inv.Invoice("INV-2", "acme", date(2026, 1, 1))
        inv.add_line(first, "WIDGET-B4", 100, 1)
        inv.add_line(second, "WIDGET-B4", 100, 1)
        self.assertEqual(len(second.lines), 1)

    def test_bug_B5_cheapest_line_found(self):
        invoice = make((("A", 500, 1), ("B", 200, 1), ("C", 900, 1)))
        self.assertEqual(inv.cheapest_line(invoice).sku, "B")


class Unplanted(unittest.TestCase):
    def test_ok_tax_is_twenty_percent_of_subtotal(self):
        invoice = make()
        self.assertEqual(inv.tax(invoice), inv.subtotal(invoice) // 5)

    def test_ok_due_date_is_thirty_days(self):
        self.assertEqual(inv.due_date(make()), date(2026, 1, 31))

    def test_ok_add_line_rejects_bad_input(self):
        invoice = inv.Invoice("INV-9", "acme", date(2026, 1, 1))
        with self.assertRaises(ValueError):
            inv.add_line(invoice, "X-OK-1", 100, 0, seen_skus=[])
        with self.assertRaises(ValueError):
            inv.add_line(invoice, "X-OK-2", -1, 1, seen_skus=[])

    def test_ok_remove_line(self):
        invoice = make()
        inv.remove_line(invoice, "A")
        self.assertEqual([i.sku for i in invoice.lines], ["B"])
        with self.assertRaises(KeyError):
            inv.remove_line(invoice, "missing")

    def test_ok_paid_invoice_owes_nothing(self):
        invoice = inv.mark_paid(make())
        self.assertEqual(inv.amount_due(invoice), 0)
        self.assertFalse(inv.is_overdue(invoice, date(2027, 1, 1)))

    def test_ok_credit_never_makes_amount_negative(self):
        invoice = make((("A", 0, 1),))
        self.assertEqual(inv.apply_credit(invoice, 50), 0)
        with self.assertRaises(ValueError):
            inv.apply_credit(invoice, 0)

    def test_ok_format_cents(self):
        self.assertEqual(inv.format_cents(123456), "$1234.56")
        self.assertEqual(inv.format_cents(-5), "-$0.05")

    def test_ok_parse_line(self):
        self.assertEqual(inv.parse_line(" A1 , 250, 3"), ("A1", 250, 3))
        with self.assertRaises(ValueError):
            inv.parse_line("A1,250")

    def test_ok_invoice_from_rows_and_summary(self):
        invoice = inv.invoice_from_rows("INV-7", "zed", date(2026, 2, 1), ["A,100,1"])
        s = inv.summary(invoice)
        self.assertEqual((s["number"], s["customer"], s["lines"]), ("INV-7", "zed", 1))

    def test_ok_customer_balances_group_by_customer(self):
        a = inv.mark_paid(make())
        b = make((("A", 0, 1),))
        self.assertEqual(inv.customer_balances([a, b]), {"acme": 0})

    def test_ok_aging_report_has_four_buckets(self):
        report = inv.aging_report([inv.mark_paid(make())], date(2026, 6, 1))
        self.assertEqual(report, {"current": 0, "1-30": 0, "31-60": 0, "60+": 0})


if __name__ == "__main__":
    unittest.main()
