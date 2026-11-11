# Tests for exam pack 3. MIT License. Never shown to the reviewer.
# test_bug_* tests describe correct behaviour, so each one FAILS on the planted bug it names.
# test_ok_* tests cover code without planted bugs and must pass.
# Run: python3 -m pytest packs/pack-3   (or: python3 -m unittest discover -s packs/pack-3)

import os
import sys
import threading
import time
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import settlement as st  # noqa: E402

ORIGINAL_SCHEDULE = dict(st._DEFAULT_SCHEDULE)


def epoch(*args):
    return int(datetime(*args, tzinfo=timezone.utc).timestamp())


class Base(unittest.TestCase):
    def setUp(self):
        st._DEFAULT_SCHEDULE.clear()
        st._DEFAULT_SCHEDULE.update(ORIGINAL_SCHEDULE)


class PlantedBugs(Base):
    def test_bug_B1_surcharge_is_exact_decimal_money(self):
        surcharge = st.card_surcharge(Decimal("1.00"))
        self.assertIsInstance(surcharge, Decimal)
        self.assertEqual(surcharge, Decimal("0.02"))

    @unittest.skipUnless(hasattr(time, "tzset"), "needs time.tzset (Unix)")
    def test_bug_B2_settlement_day_is_utc(self):
        old = os.environ.get("TZ")
        os.environ["TZ"] = "America/Los_Angeles"
        time.tzset()
        try:
            self.assertEqual(st.settlement_day(epoch(2026, 1, 1, 3, 0)), date(2026, 1, 1))
        finally:
            if old is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old
            time.tzset()

    def test_bug_B3_concurrent_payouts_cannot_overdraw(self):
        errors = []

        class Racing(st.Balance):
            raced = False

            def _record(self, reference, amount):
                if not self.raced:
                    self.raced = True
                    other = threading.Thread(target=self._other_payout)
                    other.start()
                    other.join(timeout=0.5)
                    self.other = other
                super()._record(reference, amount)

            def _other_payout(self):
                try:
                    self.payout(Decimal("10"), "second")
                except ValueError as e:
                    errors.append(e)

        balance = Racing(Decimal("10"))
        balance.payout(Decimal("10"), "first")
        balance.other.join(timeout=5)
        self.assertGreaterEqual(balance.available(), Decimal("0"))

    def test_bug_B4_promo_does_not_change_the_default_schedule(self):
        st.net_amount({"amount": "100.00", "promo": "no-fixed-fee"}, {})
        self.assertEqual(st.net_amount({"amount": "100.00"}, {}), Decimal("96.80"))
        self.assertEqual(st.fee_schedule()["fixed"], Decimal("0.30"))

    def test_bug_B5_midnight_charge_belongs_to_next_month_only(self):
        charges = [{"id": "c1", "amount": "10.00", "created": epoch(2026, 2, 1)}]
        self.assertEqual(st.statement(charges, {}, 2026, 1)["lines"], [])
        self.assertEqual(len(st.statement(charges, {}, 2026, 2)["lines"]), 1)


class Unplanted(Base):
    def test_ok_to_money_rounds_half_up(self):
        self.assertEqual(st.to_money("2.675"), Decimal("2.68"))
        self.assertEqual(st.to_money(3), Decimal("3.00"))

    def test_ok_processing_fee_and_cap(self):
        schedule = dict(ORIGINAL_SCHEDULE)
        self.assertEqual(st.processing_fee(Decimal("100.00"), schedule), Decimal("3.20"))
        schedule["cap"] = Decimal("1.00")
        self.assertEqual(st.processing_fee(Decimal("100.00"), schedule), Decimal("1.00"))

    def test_ok_net_amount_standard_card(self):
        self.assertEqual(st.net_amount({"amount": "100.00"}, {}), Decimal("96.80"))

    def test_ok_december_statement_rolls_into_next_year(self):
        charges = [{"id": "dec", "amount": "100.00", "created": epoch(2026, 12, 31, 23)},
                   {"id": "jan", "amount": "100.00", "created": epoch(2027, 1, 15)}]
        self.assertEqual([line["id"] for line in st.statement(charges, {}, 2026, 12)["lines"]], ["dec"])

    def test_ok_statement_total(self):
        charges = [{"id": "c1", "amount": "100.00", "created": epoch(2026, 1, 15)},
                   {"id": "c2", "amount": "100.00", "created": epoch(2026, 3, 15)}]
        data = st.statement(charges, {}, 2026, 1)
        self.assertEqual(data["total"], Decimal("96.80"))
        self.assertEqual(st.describe(data), "1 charge, net 96.80")

    def test_ok_balance_credit_and_payout(self):
        balance = st.Balance(Decimal("5"))
        balance.credit("10", "sale")
        self.assertEqual(balance.payout("12", "out"), Decimal("3.00"))
        with self.assertRaises(ValueError):
            balance.payout("4", "too much")
        self.assertEqual(balance.history, [("sale", Decimal("10.00")), ("out", Decimal("-12.00"))])

    def test_ok_payout_date_skips_weekend(self):
        self.assertEqual(st.payout_date(epoch(2026, 1, 1, 12)), date(2026, 1, 5))

    def test_ok_refund_draws_from_balance(self):
        balance = st.Balance(Decimal("100"))
        self.assertEqual(st.refund(balance, {"amount": "100.00"}, {}, "r1"), Decimal("3.20"))

    def test_ok_reconcile(self):
        self.assertEqual(st.reconcile(Decimal("10.00"), ["4", "6"])["balanced"], True)
        self.assertEqual(st.reconcile(Decimal("10.00"), ["4"])["difference"], Decimal("6.00"))

    def test_ok_merchant_overrides_and_promo(self):
        schedule = st.schedule_for({"percent": "1.5", "cap": "1"})
        self.assertEqual((schedule["percent"], schedule["cap"]), (Decimal("1.5"), Decimal("1")))
        self.assertEqual(st.net_amount({"amount": "100.00", "promo": "no-fixed-fee"}, {"percent": "2"}),
                         Decimal("98.00"))

    def test_ok_daily_payout_window_is_one_utc_day(self):
        charges = [{"id": "a", "amount": "100.00", "created": epoch(2026, 1, 5, 23, 59, 59)},
                   {"id": "b", "amount": "100.00", "created": epoch(2026, 1, 6)}]
        self.assertEqual(st.daily_payout(charges, {"percent": "2.9"}, date(2026, 1, 5)), Decimal("96.80"))

    def test_ok_utc_from_epoch(self):
        self.assertEqual(st.utc_from_epoch(0), datetime(1970, 1, 1, tzinfo=timezone.utc))


if __name__ == "__main__":
    unittest.main()
