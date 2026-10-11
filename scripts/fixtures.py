"""Test fixtures: the eight domains, plus dedicated labs for engine and
guardrail tests.

Every domain here is built the same way — create project, save schema, create
item, create rules, create strategy, validate, activate — with NO template.
That is deliberate: the test suite's claim is that a domain is configuration,
so the fixtures must not lean on prebuilt catalog templates to prove it.

Base prices are taken verbatim from the DOM-01..08 test specifications.
"""

from __future__ import annotations

from dataclasses import dataclass, field


def sig(sid, label, lo=0, hi=100, desc=""):
    return {"id": sid, "label": label, "type": "number", "min": lo, "max": hi,
            "description": desc or label}


@dataclass
class RuleSpec:
    name: str
    conditions: list[dict]
    adjustment: dict
    priority: int = 50
    stackable: bool = True
    conflict_group: str = ""
    enabled: bool = True


@dataclass
class DomainSpec:
    key: str                  # short handle used by the runner
    domain_name: str
    entity_label: str
    item_id: str
    item_name: str
    base_price: float
    cost: float
    signals: list[dict]
    attributes: list[dict] = field(default_factory=list)
    rules: list[RuleSpec] = field(default_factory=list)
    # Signal values that should make the primary rule fire.
    fire_signals: dict = field(default_factory=dict)
    # Expected price once the primary rule fires (None = just assert it moved).
    expect_price: float | None = None
    guardrails: dict = field(default_factory=lambda: {
        "max_increase_pct": 25, "max_decrease_pct": 25,
    })


DOMAINS: list[DomainSpec] = [
    # ── DOM-01 / GEN / E2E-01 ───────────────────────────────────────────
    DomainSpec(
        key="ecommerce", domain_name="E-commerce", entity_label="Product",
        item_id="P1001", item_name="Wireless Headphones",
        base_price=7000, cost=3000,
        signals=[
            sig("demand_score", "Demand score", 0, 100),
            sig("inventory", "Inventory level", 0, 100),
            sig("conversion_rate", "Conversion rate", 0, 100),
            sig("competitor_price", "Competitor price", 0, 10_000_000),
        ],
        attributes=[{"id": "category", "label": "Category", "type": "string"},
                    {"id": "brand", "label": "Brand", "type": "string"}],
        rules=[RuleSpec(
            "High demand low stock",
            [{"field": "demand_score", "operator": ">", "value": 60},
             {"field": "inventory", "operator": "<", "value": 30}],
            {"type": "percentage", "value": 10, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"demand_score": 85, "inventory": 18},
        expect_price=7700,
    ),
    # ── DOM-02 / E2E-02 ─────────────────────────────────────────────────
    DomainSpec(
        key="hospitality", domain_name="Hospitality", entity_label="Room",
        item_id="R204", item_name="Deluxe Room",
        base_price=5000, cost=2000,
        signals=[
            sig("occupancy", "Occupancy", 0, 100),
            sig("availability", "Availability", 0, 100),
            sig("booking_pace", "Booking pace", 0, 10_000),
            sig("lead_time_days", "Lead time (days)", 0, 365),
        ],
        rules=[RuleSpec(
            "High occupancy low availability",
            [{"field": "occupancy", "operator": ">", "value": 80},
             {"field": "availability", "operator": "<", "value": 20}],
            {"type": "percentage", "value": 8, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"occupancy": 88, "availability": 12},
        expect_price=5400,
    ),
    # ── DOM-03 / GEN-02 / E2E-03 ────────────────────────────────────────
    DomainSpec(
        key="transportation", domain_name="Transportation", entity_label="Ride",
        item_id="RID-A1", item_name="Sedan City Ride",
        base_price=200, cost=90,
        signals=[
            sig("demand_score", "Ride requests", 0, 100),
            sig("driver_supply", "Driver supply", 0, 100),
            sig("surge_ratio", "Demand/supply ratio", 0, 50),
            sig("traffic_index", "Traffic index", 0, 100),
        ],
        rules=[RuleSpec(
            "Surge: demand exceeds supply",
            [{"field": "driver_supply", "operator": "<", "value": 40}],
            {"type": "percentage", "value": 11, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"driver_supply": 20, "demand_score": 80, "surge_ratio": 3.1},
        expect_price=222,
    ),
    # ── DOM-04 / GEN-04 / E2E-04 ────────────────────────────────────────
    DomainSpec(
        key="travel", domain_name="Travel", entity_label="Flight Seat",
        item_id="FL-101", item_name="Economy Seat BOM-DEL",
        base_price=12000, cost=6000,
        signals=[
            sig("load_factor", "Load factor", 0, 100),
            sig("seats_remaining", "Seats remaining", 0, 1000),
            sig("days_to_departure", "Days to departure", 0, 365),
        ],
        rules=[RuleSpec(
            "Seat scarcity",
            [{"field": "seats_remaining", "operator": "<", "value": 10}],
            {"type": "percentage", "value": 15, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"seats_remaining": 5, "load_factor": 92, "days_to_departure": 3},
        expect_price=13800,
    ),
    # ── DOM-05 / GEN-03 / E2E-05 ────────────────────────────────────────
    DomainSpec(
        key="ev", domain_name="EV Charging", entity_label="Charging Session",
        item_id="EV-01", item_name="DC Fast Charge 50kW",
        base_price=300, cost=120,
        signals=[
            sig("grid_load", "Grid load", 0, 100),
            sig("charger_utilisation", "Charger utilisation", 0, 100),
            sig("queue_length", "Queue length", 0, 100),
            sig("energy_cost", "Wholesale energy cost", 0, 10_000),
        ],
        rules=[RuleSpec(
            "High grid load",
            [{"field": "grid_load", "operator": ">", "value": 80}],
            {"type": "percentage", "value": 8, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"grid_load": 90, "charger_utilisation": 95, "queue_length": 6},
        expect_price=324,
    ),
    # ── DOM-06 / E2E-06 ─────────────────────────────────────────────────
    DomainSpec(
        key="rental", domain_name="Car Rental", entity_label="Vehicle",
        item_id="CAR-01", item_name="Compact SUV",
        base_price=2500, cost=1000,
        signals=[
            sig("fleet_availability", "Fleet availability", 0, 100),
            sig("demand_score", "Demand score", 0, 100),
            sig("rental_duration_days", "Rental duration (days)", 0, 365),
        ],
        rules=[RuleSpec(
            "Fleet scarcity",
            [{"field": "fleet_availability", "operator": "<", "value": 25},
             {"field": "demand_score", "operator": ">", "value": 60}],
            {"type": "percentage", "value": 12, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"fleet_availability": 15, "demand_score": 80,
                      "rental_duration_days": 3},
        expect_price=2800,
    ),
    # ── DOM-07 / GEN-01 / E2E-07  (the no-template headline) ────────────
    DomainSpec(
        key="coworking", domain_name="Co-working Space", entity_label="Desk",
        item_id="DESK-A12", item_name="Hot Desk Floor 3",
        base_price=800, cost=300,
        signals=[
            sig("desk_occupancy", "Desk occupancy", 0, 100),
            sig("walk_in_rate", "Walk-in rate", 0, 500),
        ],
        rules=[RuleSpec(
            "Busy floor",
            [{"field": "desk_occupancy", "operator": ">", "value": 70}],
            {"type": "percentage", "value": 10, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"desk_occupancy": 78, "walk_in_rate": 9},
        expect_price=880,
    ),
    # ── DOM-08 / GEN-05 / E2E-08 ────────────────────────────────────────
    DomainSpec(
        key="banking", domain_name="Banking", entity_label="Loan/Risk Product",
        item_id="LOAN-01", item_name="Personal Loan Tier A",
        base_price=10000, cost=4000,
        signals=[
            sig("risk_score", "Risk score", 0, 100),
            sig("utilization", "Credit utilization", 0, 100),
        ],
        attributes=[{"id": "customer_segment", "label": "Customer segment",
                     "type": "string"}],
        rules=[RuleSpec(
            "Elevated risk premium",
            [{"field": "risk_score", "operator": ">", "value": 70},
             {"field": "utilization", "operator": ">", "value": 60}],
            {"type": "percentage", "value": 9, "direction": "increase"},
            priority=60,
        )],
        fire_signals={"risk_score": 85, "utilization": 75},
        expect_price=10900,
    ),
]

BY_KEY = {d.key: d for d in DOMAINS}

# Maps the spreadsheet's Domain column onto a fixture.
DOMAIN_COLUMN = {
    "E-commerce": "ecommerce",
    "Hospitality": "hospitality",
    "Transportation": "transportation",
    "Travel": "travel",
    "EV Charging": "ev",
    "Car Rental": "rental",
    "Co-working Space": "coworking",
    "Banking": "banking",
}

# ── ENG lab ─────────────────────────────────────────────────────────────
# One project carrying every rule shape the ENG-* cases need. Signals are set
# explicitly per test so the cases do not interfere with each other.

ENG_SIGNALS = [
    sig("s_a", "Signal A", 0, 1_000_000),
    sig("s_b", "Signal B", 0, 1_000_000),
    sig("s_c", "Signal C", 0, 1_000_000),
]

ENG_BASE = 1000.0
ENG_COST = 300.0

# ── GRD lab ─────────────────────────────────────────────────────────────
# GRD-03 specifies base 5000, calculated 6000, max increase 2% -> 5100.
# So the rule is +20% and the guardrail is the thing under test.

GRD_BASE = 5000.0
GRD_COST = 2000.0
