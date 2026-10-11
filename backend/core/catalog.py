"""Static catalog: service types, domain templates, and builder vocabulary.

This is the data behind every dropdown in the web UI. It exists as one served
catalog rather than being hardcoded in the frontend so that the engine and the
UI can never disagree about which operators or adjustment types are legal.

The domain templates matter more than they look. They are the proof of the core
claim: a new industry is a row in this file (or a schema an analyst types into
the UI), never a change to the pricing engine. Nothing in core/engine/ imports
this module.
"""

from __future__ import annotations

SERVICE_TYPES = [
    {"id": "ecommerce", "label": "E-commerce / Retail"},
    {"id": "hospitality", "label": "Hotels & Hospitality"},
    {"id": "transportation", "label": "Ride-hailing & Transport"},
    {"id": "travel", "label": "Travel & Airlines"},
    {"id": "banking", "label": "Banking & Financial Services"},
    {"id": "logistics", "label": "Logistics & Delivery"},
    {"id": "entertainment", "label": "Events & Entertainment"},
    {"id": "energy", "label": "Energy & Utilities"},
    {"id": "healthcare", "label": "Healthcare"},
    {"id": "saas", "label": "SaaS & Subscriptions"},
    {"id": "rental", "label": "Rentals & Leasing"},
    {"id": "other", "label": "Other"},
]

CURRENCIES = [
    {"id": "INR", "label": "Indian Rupee", "symbol": "₹"},
    {"id": "USD", "label": "US Dollar", "symbol": "$"},
    {"id": "EUR", "label": "Euro", "symbol": "€"},
    {"id": "GBP", "label": "Pound Sterling", "symbol": "£"},
    {"id": "AED", "label": "UAE Dirham", "symbol": "د.إ"},
    {"id": "SGD", "label": "Singapore Dollar", "symbol": "S$"},
    {"id": "AUD", "label": "Australian Dollar", "symbol": "A$"},
    {"id": "JPY", "label": "Japanese Yen", "symbol": "¥"},
]

# Signals every project gets for free. Time-based rules need these, and they
# are supplied from the context snapshot (never read from the server clock) so
# that replaying an old decision evaluates the day it actually happened.
BUILTIN_SIGNALS = [
    {"id": "day_of_week", "label": "Day of week", "type": "enum",
     "enum": ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
     "description": "Day the price is being evaluated for"},
    {"id": "hour_of_day", "label": "Hour of day", "type": "number", "min": 0, "max": 23,
     "description": "0-23, in the project's timezone"},
    {"id": "season", "label": "Season", "type": "string",
     "description": "Free-text season or period label supplied with events"},
]

EVENT_TYPES = [
    "view", "search", "click", "add_to_cart", "remove_from_cart",
    "purchase", "cancellation", "booking", "checkin", "checkout",
    "inventory_update", "availability_update", "competitor_price",
    "traffic_update", "supply_update", "signal_update", "custom",
]

OPERATORS = [
    {"id": ">", "label": "is above"},
    {"id": ">=", "label": "is at least"},
    {"id": "<", "label": "is below"},
    {"id": "<=", "label": "is at most"},
    {"id": "==", "label": "equals"},
    {"id": "!=", "label": "does not equal"},
    {"id": "in", "label": "is one of"},
    {"id": "not_in", "label": "is not one of"},
    {"id": "between", "label": "is between"},
]

ADJUSTMENT_TYPES = [
    {"id": "percentage", "label": "Percentage of base price"},
    {"id": "absolute", "label": "Fixed amount"},
    {"id": "multiplier", "label": "Multiply base price"},
    {"id": "set_price", "label": "Set an exact price"},
]


def _sig(sid, label, desc, lo=0, hi=100, typ="number"):
    return {"id": sid, "label": label, "type": typ, "min": lo, "max": hi,
            "description": desc}


DOMAIN_TEMPLATES = [
    {
        "id": "ecommerce",
        "domain_name": "E-commerce",
        "entity_label": "Product",
        "attributes": [
            {"id": "category", "label": "Category", "type": "string"},
            {"id": "brand", "label": "Brand", "type": "string"},
            {"id": "location", "label": "Location", "type": "string"},
        ],
        "context_signals": [
            _sig("demand_score", "Demand score", "Composite demand, 0-100"),
            _sig("inventory", "Inventory level", "Units remaining, as % of normal stock"),
            _sig("conversion_rate", "Conversion rate", "Purchases per view, %", 0, 100),
            _sig("sales_velocity", "Sales velocity", "Units sold per hour", 0, 100000),
            _sig("traffic", "Traffic", "Views per hour", 0, 1000000),
            _sig("competitor_price", "Competitor price", "Lowest competitor price",
                 0, 10_000_000),
            _sig("cart_additions", "Cart additions", "Adds per hour", 0, 100000),
        ],
    },
    {
        "id": "hospitality",
        "domain_name": "Hospitality",
        "entity_label": "Room",
        "attributes": [
            {"id": "room_type", "label": "Room type", "type": "string"},
            {"id": "location", "label": "Property location", "type": "string"},
        ],
        "context_signals": [
            _sig("occupancy", "Occupancy", "Rooms occupied, %"),
            _sig("availability", "Availability", "Rooms free, %"),
            _sig("booking_pace", "Booking pace", "Bookings per hour", 0, 10000),
            _sig("lead_time_days", "Lead time", "Days until check-in", 0, 365),
            _sig("competitor_price", "Competitor rate", "Comparable room rate",
                 0, 10_000_000),
            _sig("cancellation_rate", "Cancellation rate", "Cancellations, %"),
        ],
    },
    {
        "id": "transportation",
        "domain_name": "Transportation",
        "entity_label": "Ride",
        "attributes": [
            {"id": "ride_type", "label": "Ride type", "type": "string"},
            {"id": "zone", "label": "Zone", "type": "string"},
        ],
        "context_signals": [
            _sig("demand_score", "Ride requests", "Requests in the zone, indexed 0-100"),
            _sig("driver_supply", "Driver supply", "Available drivers, indexed 0-100"),
            _sig("surge_ratio", "Demand/supply ratio", "Requests per driver", 0, 50),
            _sig("traffic_index", "Traffic", "Congestion index 0-100"),
            _sig("distance_km", "Trip distance", "Kilometres", 0, 2000),
            _sig("eta_minutes", "Pickup ETA", "Minutes", 0, 180),
        ],
    },
    {
        "id": "travel",
        "domain_name": "Travel",
        "entity_label": "Flight seat",
        "attributes": [
            {"id": "route", "label": "Route", "type": "string"},
            {"id": "cabin", "label": "Cabin class", "type": "string"},
        ],
        "context_signals": [
            _sig("load_factor", "Load factor", "Seats sold, %"),
            _sig("seats_remaining", "Seats remaining", "Seats left", 0, 1000),
            _sig("days_to_departure", "Days to departure", "Days", 0, 365),
            _sig("search_volume", "Search volume", "Searches per hour", 0, 1_000_000),
            _sig("competitor_price", "Competitor fare", "Comparable fare", 0, 10_000_000),
        ],
    },
    {
        "id": "energy",
        "domain_name": "EV Charging",
        "entity_label": "Charging session",
        "attributes": [
            {"id": "station_id", "label": "Station", "type": "string"},
            {"id": "connector_type", "label": "Connector type", "type": "string"},
        ],
        "context_signals": [
            _sig("grid_load", "Grid load", "Local grid utilisation, %"),
            _sig("charger_utilisation", "Charger utilisation", "Chargers busy, %"),
            _sig("queue_length", "Queue length", "Vehicles waiting", 0, 100),
            _sig("energy_cost", "Wholesale energy cost", "Cost per kWh", 0, 10000),
            _sig("renewable_share", "Renewable share", "Renewable supply, %"),
        ],
    },
    {
        "id": "rental",
        "domain_name": "Car Rental",
        "entity_label": "Vehicle",
        "attributes": [
            {"id": "vehicle_type", "label": "Vehicle type", "type": "string"},
            {"id": "location", "label": "Pickup location", "type": "string"},
        ],
        "context_signals": [
            _sig("fleet_availability", "Fleet availability", "Vehicles free, %"),
            _sig("demand_score", "Demand score", "Booking demand 0-100"),
            _sig("rental_duration_days", "Rental duration", "Days", 0, 365),
            _sig("competitor_price", "Competitor rate", "Daily rate", 0, 10_000_000),
        ],
    },
]


def template(template_id: str) -> dict | None:
    return next((t for t in DOMAIN_TEMPLATES if t["id"] == template_id), None)


def catalog() -> dict:
    """Everything the UI needs to render its dropdowns, in one payload."""
    return {
        "service_types": SERVICE_TYPES,
        "currencies": CURRENCIES,
        "domain_templates": DOMAIN_TEMPLATES,
        "builtin_signals": BUILTIN_SIGNALS,
        "event_types": EVENT_TYPES,
        "operators": OPERATORS,
        "adjustment_types": ADJUSTMENT_TYPES,
        "strategy_modes": ["draft", "validated", "shadow", "active", "paused"],
        "alert_severities": ["info", "warning", "critical"],
    }
