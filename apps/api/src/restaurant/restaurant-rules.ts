/**
 * 1to1OS Business — Restaurants & Cafés: the pure rules every restaurant
 * route shares — who may do what, how an order moves, and how it is priced.
 * No database here, so each rule is tested on its own.
 */

import { Decimal } from '@ufuq/money';

export const RESTAURANT_ACTIVITY = 'food';

/** The company roles that act as the restaurant owner. */
export const OWNER_ROLES: readonly string[] = ['admin', 'super_admin'];

export const RESTAURANT_ROLES = ['cashier', 'waiter', 'kitchen', 'delivery'] as const;
export type RestaurantRoleKey = (typeof RESTAURANT_ROLES)[number];

export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = [
  'new',
  'preparing',
  'ready',
  'served',
  'picked_up',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Still in the kitchen or waiting to be handed over. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ['new', 'preparing', 'ready'];

/**
 * What each role may do. The owner holds everything. Kitchen staff never
 * receive prices or totals: their screens are built from a payload without them.
 */
export const ACTIONS = [
  'menu.view',
  'orders.create',
  'orders.view',
  'orders.cancel',
  'orders.prices',
  'kitchen.view',
  'kitchen.update',
  'waiter.view',
  'serve',
  'pickup',
  'deliver',
  'tables.view',
  'waiter.assign',
] as const;
export type RestaurantAction = (typeof ACTIONS)[number];

export const ROLE_ACTIONS: Readonly<Record<RestaurantRoleKey, readonly RestaurantAction[]>> = {
  cashier: [
    'menu.view',
    'orders.create',
    'orders.view',
    'orders.cancel',
    'orders.prices',
    'serve',
    'pickup',
    'deliver',
    'tables.view',
    'waiter.assign',
  ],
  waiter: ['waiter.view', 'serve', 'tables.view'],
  kitchen: ['kitchen.view', 'kitchen.update'],
  // Phase R2 adds the delivery dashboard; until then a delivery employee only signs in.
  delivery: [],
};

export function roleAllows(role: RestaurantRoleKey, action: RestaurantAction): boolean {
  return ROLE_ACTIONS[role].includes(action);
}

/** The status a kitchen "Done" leads to, and the hand-over that follows it. */
export const FULFILMENT_STATUS: Readonly<Record<OrderType, OrderStatus>> = {
  dine_in: 'served',
  takeaway: 'picked_up',
  delivery: 'delivered',
};

/** The action a transition needs, or null when the move is never allowed. */
export function transitionAction(
  type: OrderType,
  from: OrderStatus,
  to: OrderStatus,
): RestaurantAction | null {
  if (from === to) return null;
  // The kitchen's own steps, including one step back for a mistaken tap.
  if (from === 'new' && (to === 'preparing' || to === 'ready')) return 'kitchen.update';
  if (from === 'preparing' && (to === 'ready' || to === 'new')) return 'kitchen.update';
  if (from === 'ready' && to === 'preparing') return 'kitchen.update';
  // The hand-over, which depends on how the order leaves.
  if (from === 'ready' && to === FULFILMENT_STATUS[type]) {
    return type === 'dine_in' ? 'serve' : type === 'takeaway' ? 'pickup' : 'deliver';
  }
  return null;
}

/** Only an order the kitchen has not finished may be cancelled. */
export function cancellable(status: OrderStatus): boolean {
  return status === 'new' || status === 'preparing';
}

// ---------------------------------------------------------------------------
// Pricing — money never touches a float (DOCUMENT 27 RULE 17)
// ---------------------------------------------------------------------------

export const MONEY_SCALE = 2;

export function money(value: { toString(): string }): Decimal {
  return Decimal.parse(value.toString(), MONEY_SCALE);
}

/** amount × rate% rounded once to 0.01 (half away from zero). */
export function percentOf(amount: Decimal, ratePercent: Decimal): Decimal {
  // At scale 6 both the product and the division by 100 are exact.
  return amount
    .rescale(6)
    .multiply(ratePercent, 'none')
    .divideByInteger(100, 'none')
    .rescale(MONEY_SCALE, 'nearest');
}

export interface PricedLine {
  readonly basePrice: Decimal;
  readonly optionPrices: readonly Decimal[];
  readonly quantity: number;
}

export interface LineTotals {
  readonly unitPrice: Decimal;
  readonly lineTotal: Decimal;
}

export function priceLine(line: PricedLine): LineTotals {
  const unitPrice = Decimal.sum([line.basePrice, ...line.optionPrices], MONEY_SCALE);
  return { unitPrice, lineTotal: unitPrice.multiplyByInteger(line.quantity) };
}

export interface OrderTotals {
  readonly subtotal: Decimal;
  readonly discount: Decimal;
  readonly service: Decimal;
  readonly tax: Decimal;
  readonly total: Decimal;
}

/**
 * subtotal − discount, then the service charge (dine-in only) on that, then
 * tax on both — VAT in Egypt is charged on the service charge too.
 */
export function orderTotals(input: {
  readonly lines: readonly Decimal[];
  readonly discount: Decimal;
  readonly type: OrderType;
  readonly taxRate: Decimal;
  readonly serviceRate: Decimal;
}): OrderTotals | 'discount_too_large' {
  const subtotal = Decimal.sum(input.lines, MONEY_SCALE);
  if (input.discount.isNegative() || input.discount.compare(subtotal) > 0)
    return 'discount_too_large';
  const net = subtotal.subtract(input.discount);
  const service =
    input.type === 'dine_in' ? percentOf(net, input.serviceRate) : Decimal.zero(MONEY_SCALE);
  const tax = percentOf(net.add(service), input.taxRate);
  return { subtotal, discount: input.discount, service, tax, total: net.add(service).add(tax) };
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function minutesOf(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number.parseInt(h, 10) * 60 + Number.parseInt(m, 10);
}

/** Scheduled minutes of one shift, minus the break; a shift may cross midnight. */
export function shiftMinutes(
  start: string | null,
  end: string | null,
  breakMinutes: number,
): number {
  if (!start || !end || !TIME_PATTERN.test(start) || !TIME_PATTERN.test(end)) return 0;
  let span = minutesOf(end) - minutesOf(start);
  if (span <= 0) span += 24 * 60;
  return Math.max(0, span - breakMinutes);
}
