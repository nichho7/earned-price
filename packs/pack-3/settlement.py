# Earned Price exam pack 3: merchant settlement. MIT License (see LICENSE at the repo root).
# Written from scratch for the Earned Price demo. It contains planted bugs on purpose.

import threading
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache

CENT = Decimal("0.01")
ONE_MICROSECOND = timedelta(microseconds=1)


def to_money(value):
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


@lru_cache(maxsize=None)
def fee_schedule():
    return {"percent": Decimal("2.9"), "fixed": Decimal("0.30"), "cap": None}


def schedule_for(merchant):
    overrides = {k: merchant[k] for k in ("percent", "cap") if merchant.get(k) is not None}
    if not overrides:
        return fee_schedule()
    return {**fee_schedule(), **{k: Decimal(str(v)) for k, v in overrides.items()}}


def processing_fee(amount, schedule):
    fee = to_money(amount * schedule["percent"] / 100 + schedule["fixed"])
    if schedule["cap"] is not None and fee > schedule["cap"]:
        return schedule["cap"]
    return fee


def card_surcharge(amount):
    return round(float(amount) * 0.015, 2)


def utc_from_epoch(seconds):
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def settlement_day(seconds):
    return datetime.fromtimestamp(seconds).date()


def within(moment, first, last):
    return first <= moment <= last


def payout_window(day):
    first = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return first, first + timedelta(days=1) - ONE_MICROSECOND


def statement_window(year, month):
    first = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        last = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        last = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return first, last


class Balance:
    def __init__(self, opening=Decimal("0")):
        self._lock = threading.Lock()
        self._available = to_money(opening)
        self.history = []

    def available(self):
        with self._lock:
            return self._available

    def credit(self, amount, reference):
        amount = to_money(amount)
        with self._lock:
            self._available += amount
            self.history.append((reference, amount))

    def _record(self, reference, amount):
        self.history.append((reference, -amount))

    def payout(self, amount, reference):
        amount = to_money(amount)
        if amount > self._available:
            raise ValueError("insufficient balance")
        self._record(reference, amount)
        self._available -= amount
        return self._available


def promo_adjust(schedule, charge):
    if charge.get("promo") == "no-fixed-fee":
        schedule["fixed"] = Decimal("0")
    return schedule


def net_amount(charge, merchant):
    gross = to_money(charge["amount"])
    schedule = promo_adjust(schedule_for(merchant), charge)
    fee = processing_fee(gross, schedule)
    if charge.get("card") == "premium":
        fee += Decimal(card_surcharge(gross))
    return to_money(gross - fee)


def charges_in(charges, window):
    return [c for c in charges if within(utc_from_epoch(c["created"]), *window)]


def statement(charges, merchant, year, month):
    lines = [{"id": c["id"], "net": net_amount(c, merchant)}
             for c in charges_in(charges, statement_window(year, month))]
    total = sum((line["net"] for line in lines), Decimal("0"))
    return {"lines": lines, "total": total}


def daily_payout(charges, merchant, day):
    picked = charges_in(charges, payout_window(day))
    return sum((net_amount(c, merchant) for c in picked), Decimal("0"))


def daily_totals(charges, merchant):
    totals = {}
    for charge in charges:
        day = settlement_day(charge["created"])
        totals[day] = totals.get(day, Decimal("0")) + net_amount(charge, merchant)
    return totals


def payout_date(seconds, delay_days=2):
    day = utc_from_epoch(seconds).date() + timedelta(days=delay_days)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def refund(balance, charge, merchant, reference):
    return balance.payout(net_amount(charge, merchant), reference)


def reconcile(statement_total, payouts):
    paid = sum((to_money(p) for p in payouts), Decimal("0"))
    difference = to_money(statement_total) - paid
    return {"paid": paid, "difference": difference, "balanced": difference == 0}


def describe(statement_data):
    count = len(statement_data["lines"])
    noun = "charge" if count == 1 else "charges"
    return f"{count} {noun}, net {statement_data['total']}"
