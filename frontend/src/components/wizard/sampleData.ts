import type { DraftItem } from './buildTests';

/**
 * Sample catalogues, one per template.
 *
 * These exist so somebody can get to a working pricing system without first
 * finding a CSV. They are created through the ordinary `/items/create` API —
 * there is no special "demo mode" in the backend, and nothing here is fake: the
 * engine prices them exactly as it would prices anything else.
 *
 * The prices deliberately SPAN a wide range within each catalogue (a ₹50 pen
 * next to a ₹4,500 headphone). That is the point the product has to make early:
 * one project prices items of wildly different value, so a project-wide
 * absolute price floor would be nonsense.
 */

export interface SampleSet {
  items: DraftItem[];
  /** A rule that genuinely suits this domain, offered as a starting point. */
  suggestedRule: { name: string; field: string; operator: '>' | '<'; value: number; percent: number };
}

const SAMPLES: Record<string, SampleSet> = {
  ecommerce: {
    items: [
      { item_id: 'P1001', name: 'Ball Pen', base_price: 50, cost: 20 },
      { item_id: 'P1002', name: 'Notebook', base_price: 120, cost: 50 },
      { item_id: 'P1003', name: 'USB-C Cable', base_price: 600, cost: 250 },
      { item_id: 'P1004', name: 'Wireless Headphones', base_price: 4500, cost: 2600 },
    ],
    suggestedRule: {
      name: 'High demand premium',
      field: 'demand_score',
      operator: '>',
      value: 80,
      percent: 5,
    },
  },
  hospitality: {
    items: [
      { item_id: 'R101', name: 'Standard Room', base_price: 3200, cost: 1400 },
      { item_id: 'R204', name: 'Deluxe Double', base_price: 5000, cost: 2100 },
      { item_id: 'R301', name: 'Executive Suite', base_price: 12000, cost: 4800 },
    ],
    suggestedRule: {
      name: 'Nearly full premium',
      field: 'occupancy',
      operator: '>',
      value: 80,
      percent: 8,
    },
  },
  transportation: {
    items: [
      { item_id: 'RIDE-ECO', name: 'Economy', base_price: 120, cost: 70 },
      { item_id: 'RIDE-PRE', name: 'Premium', base_price: 260, cost: 150 },
      { item_id: 'RIDE-XL', name: 'XL (6 seats)', base_price: 380, cost: 210 },
    ],
    suggestedRule: {
      name: 'Surge on low driver supply',
      field: 'driver_supply',
      operator: '<',
      value: 30,
      percent: 15,
    },
  },
  travel: {
    items: [
      { item_id: 'FL-ECO', name: 'Economy Seat', base_price: 4200, cost: 2400 },
      { item_id: 'FL-PREM', name: 'Premium Economy', base_price: 8600, cost: 4100 },
      { item_id: 'FL-BUS', name: 'Business Class', base_price: 24000, cost: 11000 },
    ],
    suggestedRule: {
      name: 'Last seats premium',
      field: 'seats_left',
      operator: '<',
      value: 20,
      percent: 12,
    },
  },
  rental: {
    items: [
      { item_id: 'CAR-HATCH', name: 'Hatchback', base_price: 1800, cost: 900 },
      { item_id: 'CAR-SEDAN', name: 'Sedan', base_price: 2900, cost: 1500 },
      { item_id: 'CAR-SUV', name: 'SUV', base_price: 4600, cost: 2400 },
    ],
    suggestedRule: {
      name: 'Low fleet availability',
      field: 'availability',
      operator: '<',
      value: 25,
      percent: 10,
    },
  },
  energy: {
    items: [
      { item_id: 'CHG-AC', name: 'AC Charging (per kWh)', base_price: 12, cost: 7 },
      { item_id: 'CHG-DC', name: 'DC Fast (per kWh)', base_price: 22, cost: 13 },
      { item_id: 'CHG-ULTRA', name: 'Ultra Fast (per kWh)', base_price: 34, cost: 19 },
    ],
    suggestedRule: {
      name: 'Peak grid load premium',
      field: 'grid_load',
      operator: '>',
      value: 75,
      percent: 10,
    },
  },
};

/** The generic fallback, used for a custom domain with no sample of its own. */
const GENERIC: SampleSet = {
  items: [
    { item_id: 'ITEM-001', name: 'Entry tier', base_price: 100, cost: 45 },
    { item_id: 'ITEM-002', name: 'Standard tier', base_price: 450, cost: 210 },
    { item_id: 'ITEM-003', name: 'Premium tier', base_price: 1800, cost: 820 },
  ],
  suggestedRule: {
    name: 'High demand premium',
    field: 'demand_score',
    operator: '>',
    value: 80,
    percent: 5,
  },
};

/**
 * Pick the catalogue for a template or domain name.
 *
 * Matched loosely on purpose: the caller may have a template id
 * ("hospitality"), a domain name the user typed ("Hotels & Resorts"), or
 * nothing at all. A near-miss returning the generic set is a better outcome
 * than no sample data.
 */
export function sampleFor(templateId?: string | null, domainName?: string | null): SampleSet {
  const key = (templateId || '').toLowerCase();
  if (SAMPLES[key]) return SAMPLES[key]!;

  const hay = `${templateId ?? ''} ${domainName ?? ''}`.toLowerCase();
  const guesses: [string, string][] = [
    ['hotel', 'hospitality'],
    ['room', 'hospitality'],
    ['hospitality', 'hospitality'],
    ['ride', 'transportation'],
    ['transport', 'transportation'],
    ['taxi', 'transportation'],
    ['flight', 'travel'],
    ['airline', 'travel'],
    ['travel', 'travel'],
    ['rental', 'rental'],
    ['car', 'rental'],
    ['charg', 'energy'],
    ['ev', 'energy'],
    ['energy', 'energy'],
    ['commerce', 'ecommerce'],
    ['retail', 'ecommerce'],
    ['shop', 'ecommerce'],
    ['product', 'ecommerce'],
  ];
  for (const [needle, id] of guesses) {
    if (hay.includes(needle)) return SAMPLES[id] ?? GENERIC;
  }
  return GENERIC;
}
