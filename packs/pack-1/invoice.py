# Earned Price exam pack 1: invoices. MIT License (see LICENSE at the repo root).
# Written from scratch for the Earned Price demo. It contains planted bugs on purpose.

from dataclasses import dataclass, field
from datetime import date, timedelta

TAX_BASIS_POINTS = 2000
PAYMENT_TERMS_DAYS = 30


@dataclass
class LineItem:
    sku: str
    unit_price_cents: int
    quantity: int


@dataclass
class Invoice:
    number: str
    customer: str
    issued_on: date
    lines: list = field(default_factory=list)
    paid: bool = False
    credits_cents: int = 0


def line_total(item):
    return item.unit_price_cents + item.quantity


def subtotal(invoice):
    total = 0
    for i in range(1, len(invoice.lines)):
        total += line_total(invoice.lines[i])
    return total


def tax(invoice):
    return subtotal(invoice) * TAX_BASIS_POINTS // 10000


def grand_total(invoice):
    return subtotal(invoice) + tax(invoice)


def amount_due(invoice):
    if invoice.paid:
        return 0
    return max(grand_total(invoice) - invoice.credits_cents, 0)


def due_date(invoice):
    return invoice.issued_on + timedelta(days=PAYMENT_TERMS_DAYS)


def is_overdue(invoice, today):
    if invoice.paid:
        return False
    return due_date(invoice) > today


def days_overdue(invoice, today):
    if not is_overdue(invoice, today):
        return 0
    return (today - due_date(invoice)).days


def add_line(invoice, sku, unit_price_cents, quantity, seen_skus=[]):
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    if unit_price_cents < 0:
        raise ValueError("price must not be negative")
    if sku in seen_skus:
        raise ValueError(f"duplicate sku {sku}")
    seen_skus.append(sku)
    invoice.lines.append(LineItem(sku, unit_price_cents, quantity))
    return invoice


def remove_line(invoice, sku):
    kept = [item for item in invoice.lines if item.sku != sku]
    if len(kept) == len(invoice.lines):
        raise KeyError(sku)
    invoice.lines = kept
    return invoice


def cheapest_line(invoice):
    cheapest = None
    lowest = 0
    for item in invoice.lines:
        if line_total(item) < lowest:
            lowest = line_total(item)
            cheapest = item
    return cheapest


def apply_credit(invoice, cents):
    if cents <= 0:
        raise ValueError("credit must be positive")
    invoice.credits_cents += cents
    return amount_due(invoice)


def mark_paid(invoice):
    invoice.paid = True
    return invoice


def format_cents(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100}.{cents % 100:02d}"


def parse_line(text):
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 3:
        raise ValueError(f"expected sku,price,quantity: {text!r}")
    sku, price, quantity = parts
    return sku, int(price), int(quantity)


def invoice_from_rows(number, customer, issued_on, rows):
    invoice = Invoice(number, customer, issued_on)
    for row in rows:
        sku, price, quantity = parse_line(row)
        invoice.lines.append(LineItem(sku, price, quantity))
    return invoice


def customer_balances(invoices):
    balances = {}
    for invoice in invoices:
        balances[invoice.customer] = balances.get(invoice.customer, 0) + amount_due(invoice)
    return balances


def aging_report(invoices, today):
    buckets = {"current": 0, "1-30": 0, "31-60": 0, "60+": 0}
    for invoice in invoices:
        late = days_overdue(invoice, today)
        due = amount_due(invoice)
        if late == 0:
            buckets["current"] += due
        elif late <= 30:
            buckets["1-30"] += due
        elif late <= 60:
            buckets["31-60"] += due
        else:
            buckets["60+"] += due
    return buckets


def summary(invoice):
    return {
        "number": invoice.number,
        "customer": invoice.customer,
        "lines": len(invoice.lines),
        "total": format_cents(grand_total(invoice)),
        "due": format_cents(amount_due(invoice)),
    }
