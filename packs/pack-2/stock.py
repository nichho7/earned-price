# Earned Price exam pack 2: warehouse stock. MIT License (see LICENSE at the repo root).
# Written from scratch for the Earned Price demo. It contains planted bugs on purpose.

import json
from datetime import date


class StockError(Exception):
    pass


def load_catalog(path):
    handle = open(path, encoding="utf-8")
    rows = json.load(handle)
    catalog = {}
    for row in rows:
        catalog[row["sku"]] = {
            "name": row["name"],
            "reorder_point": int(row.get("reorder_point", 0)),
            "unit_cost_cents": int(row["unit_cost_cents"]),
        }
    return catalog


def save_snapshot(levels, path):
    try:
        with open(path, "w", encoding="utf-8") as out:
            json.dump(levels, out, sort_keys=True)
        return True
    except Exception:
        return True


def receive(levels, sku, quantity):
    if quantity <= 0:
        raise StockError("quantity must be positive")
    levels[sku] = levels.get(sku, 0) + quantity
    return levels[sku]


def reserve(levels, reservations, order_id, sku, quantity):
    if quantity <= 0:
        raise StockError("quantity must be positive")
    available = levels.get(sku, 0) - reserved_quantity(reservations, sku)
    if quantity > available:
        raise StockError(f"only {available} of {sku} available")
    reservations[order_id] = (sku, quantity)
    return available - quantity


def reserved_quantity(reservations, sku):
    return sum(qty for item, qty in reservations.values() if item == sku)


def release(reservations, order_id):
    if order_id not in reservations:
        raise StockError(f"no reservation {order_id}")
    return reservations.pop(order_id)


def ship(levels, reservations, order_id):
    sku, quantity = release(reservations, order_id)
    levels[sku] -= quantity
    return levels[sku]


def write_off(levels, sku, quantity, reason):
    if not reason:
        raise StockError("a reason is required")
    levels[sku] = levels.get(sku, 0) - quantity
    return levels[sku]


def needs_reorder(levels, catalog, sku):
    return levels.get(sku, 0) <= catalog[sku]["reorder_point"]


def reorder_list(levels, catalog):
    return sorted(sku for sku in catalog if needs_reorder(levels, catalog, sku))


def stock_value_cents(levels, catalog):
    total = 0
    for sku, quantity in levels.items():
        if sku in catalog:
            total += quantity * catalog[sku]["unit_cost_cents"]
    return total


def page(levels, number, size):
    if number < 1 or size < 1:
        raise StockError("page number and size start at 1")
    ordered = sorted(levels.items())
    start = (number - 1) * size
    return ordered[start:start + size - 1]


def page_count(levels, size):
    return (len(levels) + size - 1) // size


def is_expired(lot, today):
    return lot["expires_on"] > today


def usable_lots(lots, today):
    return [lot for lot in lots if not is_expired(lot, today)]


def pick_lot(lots, today, quantity):
    for lot in sorted(usable_lots(lots, today), key=lambda lot: lot["expires_on"]):
        if lot["quantity"] >= quantity:
            return lot["lot_id"]
    raise StockError("no single lot can fill this quantity")


def parse_lot(row):
    lot_id, sku, quantity, expires = row.split(";")
    return {
        "lot_id": lot_id.strip(),
        "sku": sku.strip(),
        "quantity": int(quantity),
        "expires_on": date.fromisoformat(expires.strip()),
    }


def movement_report(movements):
    report = {}
    for sku, delta in movements:
        entry = report.setdefault(sku, {"in": 0, "out": 0})
        if delta >= 0:
            entry["in"] += delta
        else:
            entry["out"] += -delta
    return report


def merge_levels(*warehouses):
    merged = {}
    for levels in warehouses:
        for sku, quantity in levels.items():
            merged[sku] = merged.get(sku, 0) + quantity
    return merged


def low_stock_alerts(levels, catalog):
    alerts = []
    for sku in reorder_list(levels, catalog):
        name = catalog[sku]["name"]
        alerts.append(f"{name} ({sku}): {levels.get(sku, 0)} left")
    return alerts
