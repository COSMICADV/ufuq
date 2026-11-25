/**
 * 1to1OS Business — Restaurants & Cafés: the shapes the /restaurant API
 * returns, the calls the screens make, and the cart's price preview.
 *
 * Every permission shown here is checked again by the API; the screen only
 * decides what to draw. The cart's totals are a preview: the server prices
 * every confirmed order again from the menu, and its totals are what count.
 */

import type { Locale } from '@ufuq/i18n';

import { apiUrl, fetchOne, uploadForm } from './api-client';

export const RESTAURANT_ROLES = ['cashier', 'waiter', 'kitchen', 'delivery'] as const;
export type RestaurantRole = (typeof RESTAURANT_ROLES)[number];

export type OrderType = 'dine_in' | 'takeaway' | 'delivery';
export type OrderStatus =
  | 'new'
  | 'preparing'
  | 'ready'
  | 'served'
  | 'picked_up'
  | 'delivered'
  | 'cancelled';

export type RestaurantAction =
  | 'menu.view'
  | 'orders.create'
  | 'orders.view'
  | 'orders.cancel'
  | 'orders.prices'
  | 'kitchen.view'
  | 'kitchen.update'
  | 'waiter.view'
  | 'serve'
  | 'pickup'
  | 'deliver'
  | 'tables.view'
  | 'waiter.assign';

export interface BranchRef {
  readonly id: string;
  readonly name: string;
}

export interface WorkBranch extends BranchRef {
  readonly tax_rate: string;
  readonly service_rate: string;
}

export interface RestaurantMe {
  readonly enabled: boolean;
  readonly owner: boolean;
  readonly employee_id: string | null;
  readonly role: RestaurantRole | null;
  readonly branch: WorkBranch | null;
  readonly branches: readonly WorkBranch[];
  readonly actions: readonly RestaurantAction[];
  readonly currency: string;
  readonly time_zone: string;
}

export interface Branch extends BranchRef {
  readonly address: string | null;
  readonly phone: string | null;
  readonly tax_rate: string;
  readonly service_rate: string;
  readonly archived: boolean;
  readonly staff_count: number;
  readonly table_count: number;
}

export interface StaffMember {
  readonly employee_id: string;
  readonly name: string;
  readonly employee_code: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly employee_status: string;
  readonly has_login: boolean;
  readonly restaurant: {
    readonly branch: BranchRef;
    readonly role: RestaurantRole;
    readonly job_title: string | null;
    readonly working_days: readonly number[];
    readonly shift_start: string | null;
    readonly shift_end: string | null;
    readonly break_minutes: number;
    readonly weekly_minutes: number;
    readonly active: boolean;
  } | null;
}

export interface PersonRef {
  readonly id: string;
  readonly name: string;
}

export interface Table {
  readonly id: string;
  readonly branch_id: string;
  readonly label: string;
  readonly seats: number;
  readonly default_waiter: PersonRef | null;
  readonly archived: boolean;
  readonly occupied_by: {
    readonly id: string;
    readonly number: number;
    readonly status: OrderStatus;
  } | null;
}

export interface MenuCategory {
  readonly id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly archived: boolean;
  readonly item_count: number;
}

export interface MenuSize {
  readonly id: string;
  readonly name: string;
  readonly price: string;
}

export interface MenuOption {
  readonly id: string;
  readonly kind: 'extra' | 'customization';
  readonly name: string;
  readonly price: string;
}

export interface MenuItem {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: string;
  readonly available: boolean;
  readonly sort_order: number;
  readonly archived: boolean;
  readonly image_version: number | null;
  readonly sizes: readonly MenuSize[];
  readonly options: readonly MenuOption[];
  readonly ingredients?: string | null;
  readonly recipe?: string | null;
  readonly prep_instructions?: string | null;
}

export interface Menu {
  readonly categories: readonly MenuCategory[];
  readonly items: readonly MenuItem[];
  readonly can_manage: boolean;
}

export interface OrderLine {
  readonly id: string;
  readonly menu_item_id: string | null;
  readonly name: string;
  readonly size_name: string | null;
  readonly quantity: number;
  readonly options: readonly {
    readonly kind: 'extra' | 'customization';
    readonly name: string;
    readonly price?: string;
  }[];
  readonly notes: string | null;
  readonly image_version: number | null;
  readonly unit_price?: string;
  readonly line_total?: string;
}

export interface Order {
  readonly id: string;
  readonly branch: BranchRef;
  readonly number: number;
  readonly type: OrderType;
  readonly status: OrderStatus;
  readonly table: { readonly id: string; readonly label: string } | null;
  readonly waiter: PersonRef | null;
  readonly customer_name: string | null;
  readonly customer_phone: string | null;
  readonly delivery_address: string | null;
  readonly notes: string | null;
  readonly items: readonly OrderLine[];
  readonly created_by: string;
  readonly created_at: string;
  readonly preparing_at: string | null;
  readonly ready_at: string | null;
  readonly fulfilled_at: string | null;
  readonly cancelled_at: string | null;
  readonly cancel_reason: string | null;
  readonly totals?: {
    readonly subtotal: string;
    readonly discount: string;
    readonly service: string;
    readonly tax: string;
    readonly total: string;
    readonly tax_rate: string;
    readonly service_rate: string;
  };
  readonly history?: readonly {
    readonly from: OrderStatus | null;
    readonly to: OrderStatus;
    readonly at: string;
    readonly by: string;
    readonly note: string | null;
  }[];
}

export type OrderView = 'active' | 'kitchen' | 'waiter' | 'pickup' | 'history';

export interface OrderEvent {
  readonly kind: 'created' | 'status' | 'updated';
  readonly branch_id: string;
  readonly order_id: string;
  readonly number: number;
  readonly type: OrderType;
  readonly status: OrderStatus;
  readonly waiter_id: string | null;
  readonly at: string;
}

export const FULFILMENT: Readonly<Record<OrderType, 'served' | 'picked_up' | 'delivered'>> = {
  dine_in: 'served',
  takeaway: 'picked_up',
  delivery: 'delivered',
};

function opts(locale: Locale, signal?: AbortSignal): { locale: Locale; signal?: AbortSignal } {
  return { locale, ...(signal ? { signal } : {}) };
}

function branchQuery(branchId: string | null): Record<string, string> {
  return branchId ? { branch_id: branchId } : {};
}

// --- Me, branches, team, tables -----------------------------------------------

export function loadRestaurantMe(locale: Locale, signal?: AbortSignal): Promise<RestaurantMe> {
  return fetchOne<RestaurantMe>('/restaurant/me', opts(locale, signal));
}

export function loadBranches(locale: Locale, signal?: AbortSignal): Promise<Branch[]> {
  return fetchOne<Branch[]>('/restaurant/branches', opts(locale, signal));
}

export interface BranchInput {
  readonly name?: string;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly tax_rate?: string;
  readonly service_rate?: string;
  readonly archived?: boolean;
}

export function saveBranch(
  locale: Locale,
  id: string | null,
  body: BranchInput,
): Promise<Branch[]> {
  return fetchOne<Branch[]>(id ? `/restaurant/branches/${id}` : '/restaurant/branches', {
    locale,
    method: id ? 'PATCH' : 'POST',
    body,
  });
}

export function loadStaff(locale: Locale, signal?: AbortSignal): Promise<StaffMember[]> {
  return fetchOne<StaffMember[]>('/restaurant/staff', opts(locale, signal));
}

export interface StaffInput {
  readonly branch_id: string;
  readonly role: RestaurantRole;
  readonly job_title: string | null;
  readonly working_days: readonly number[];
  readonly shift_start: string | null;
  readonly shift_end: string | null;
  readonly break_minutes: number;
  readonly active: boolean;
}

export function saveStaff(
  locale: Locale,
  employeeId: string,
  body: StaffInput,
): Promise<StaffMember[]> {
  return fetchOne<StaffMember[]>(`/restaurant/staff/${employeeId}`, {
    locale,
    method: 'PUT',
    body,
  });
}

export function removeStaff(locale: Locale, employeeId: string): Promise<StaffMember[]> {
  return fetchOne<StaffMember[]>(`/restaurant/staff/${employeeId}`, { locale, method: 'DELETE' });
}

export function loadWaiters(
  locale: Locale,
  branchId: string | null,
  signal?: AbortSignal,
): Promise<PersonRef[]> {
  return fetchOne<PersonRef[]>('/restaurant/waiters', {
    ...opts(locale, signal),
    query: branchQuery(branchId),
  });
}

export function loadTables(
  locale: Locale,
  branchId: string | null,
  archived = false,
  signal?: AbortSignal,
): Promise<Table[]> {
  return fetchOne<Table[]>('/restaurant/tables', {
    ...opts(locale, signal),
    query: { ...branchQuery(branchId), ...(archived ? { archived: 'true' } : {}) },
  });
}

export interface TableInput {
  readonly branch_id?: string;
  readonly label?: string;
  readonly seats?: number;
  readonly default_waiter_id?: string | null;
  readonly archived?: boolean;
}

export function saveTable(locale: Locale, id: string | null, body: TableInput): Promise<Table[]> {
  return fetchOne<Table[]>(id ? `/restaurant/tables/${id}` : '/restaurant/tables', {
    locale,
    method: id ? 'PATCH' : 'POST',
    body,
  });
}

// --- Menu ---------------------------------------------------------------------

export function loadMenu(locale: Locale, archived = false, signal?: AbortSignal): Promise<Menu> {
  return fetchOne<Menu>('/restaurant/menu', {
    ...opts(locale, signal),
    query: archived ? { archived: 'true' } : {},
  });
}

export function saveCategory(
  locale: Locale,
  id: string | null,
  body: { readonly name?: string; readonly sort_order?: number; readonly archived?: boolean },
): Promise<Menu> {
  return fetchOne<Menu>(id ? `/restaurant/menu/categories/${id}` : '/restaurant/menu/categories', {
    locale,
    method: id ? 'PATCH' : 'POST',
    body,
  });
}

export interface ItemInput {
  readonly category_id?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly price?: string;
  readonly ingredients?: string | null;
  readonly recipe?: string | null;
  readonly prep_instructions?: string | null;
  readonly available?: boolean;
  readonly archived?: boolean;
  readonly sizes?: readonly { readonly name: string; readonly price: string }[];
  readonly options?: readonly {
    readonly kind: 'extra' | 'customization';
    readonly name: string;
    readonly price: string;
  }[];
}

export function saveItem(locale: Locale, id: string | null, body: ItemInput): Promise<MenuItem> {
  return fetchOne<MenuItem>(id ? `/restaurant/menu/items/${id}` : '/restaurant/menu/items', {
    locale,
    method: id ? 'PATCH' : 'POST',
    body,
  });
}

export function uploadItemImage(locale: Locale, id: string, image: Blob): Promise<MenuItem> {
  const form = new FormData();
  form.append('image', image, image.type === 'image/png' ? 'photo.png' : 'photo.jpg');
  return uploadForm<MenuItem>(`/restaurant/menu/items/${id}/image`, form, { locale });
}

export function removeItemImage(locale: Locale, id: string): Promise<MenuItem> {
  return fetchOne<MenuItem>(`/restaurant/menu/items/${id}/image`, { locale, method: 'DELETE' });
}

/** The photo's address; the version in it changes whenever the photo does, so caching is safe. */
export function itemImageUrl(id: string, version: number): string {
  return apiUrl(`/restaurant/menu/items/${id}/image`, { v: String(version) });
}

// --- Orders -------------------------------------------------------------------

export interface OrderLineInput {
  readonly menu_item_id: string;
  readonly size_id?: string;
  readonly option_ids?: readonly string[];
  readonly quantity: number;
  readonly notes?: string | null;
}

export interface OrderInput {
  readonly client_key: string;
  readonly branch_id?: string;
  readonly type: OrderType;
  readonly table_id?: string;
  readonly waiter_id?: string | null;
  readonly customer_name?: string | null;
  readonly customer_phone?: string | null;
  readonly delivery_address?: string | null;
  readonly notes?: string | null;
  readonly discount?: string;
  readonly items: readonly OrderLineInput[];
}

export function createOrder(locale: Locale, body: OrderInput): Promise<Order> {
  return fetchOne<Order>('/restaurant/orders', { locale, method: 'POST', body });
}

export function listOrders(
  locale: Locale,
  view: OrderView,
  branchId: string | null,
  signal?: AbortSignal,
): Promise<Order[]> {
  return fetchOne<Order[]>('/restaurant/orders', {
    ...opts(locale, signal),
    query: { view, ...branchQuery(branchId) },
  });
}

export function loadOrder(locale: Locale, id: string, signal?: AbortSignal): Promise<Order> {
  return fetchOne<Order>(`/restaurant/orders/${id}`, opts(locale, signal));
}

export function setOrderStatus(
  locale: Locale,
  id: string,
  status: Exclude<OrderStatus, 'cancelled'>,
): Promise<Order> {
  return fetchOne<Order>(`/restaurant/orders/${id}/status`, {
    locale,
    method: 'POST',
    body: { status },
  });
}

export function cancelOrder(locale: Locale, id: string, reason: string): Promise<Order> {
  return fetchOne<Order>(`/restaurant/orders/${id}/cancel`, {
    locale,
    method: 'POST',
    body: { reason },
  });
}

export function setOrderWaiter(
  locale: Locale,
  id: string,
  waiterId: string | null,
): Promise<Order> {
  return fetchOne<Order>(`/restaurant/orders/${id}/waiter`, {
    locale,
    method: 'PATCH',
    body: { waiter_id: waiterId },
  });
}

export function streamUrl(branchId: string | null): string {
  return apiUrl('/restaurant/stream', branchQuery(branchId));
}

/** A fresh key for one tap of "Confirm" (the server returns the first order for a repeat). */
export function newClientKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Cart price preview (minor units as bigint — never a float) -------------------

const MONEY = /^\d{1,13}(\.\d{1,2})?$/;

export function isMoney(value: string): boolean {
  return MONEY.test(value.trim());
}

/** "12.5" → 1250n. Anything that is not a money string is 0. */
export function toMinor(value: string): bigint {
  const trimmed = value.trim();
  if (!MONEY.test(trimmed)) return 0n;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** 1250n → "12.50" */
export function fromMinor(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** amount × rate% rounded half away from zero, as the server does. */
export function percentMinor(amount: bigint, rate: string): bigint {
  const product = amount * toMinor(rate); // scale 4, ×100 for the percent
  const divisor = 10000n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

export interface CartTotals {
  readonly subtotal: string;
  readonly discount: string;
  readonly service: string;
  readonly tax: string;
  readonly total: string;
  readonly discountTooLarge: boolean;
}

export function cartTotals(input: {
  readonly lines: readonly bigint[];
  readonly discount: string;
  readonly type: OrderType;
  readonly taxRate: string;
  readonly serviceRate: string;
}): CartTotals {
  const subtotal = input.lines.reduce((sum, line) => sum + line, 0n);
  const discount = toMinor(input.discount || '0');
  const discountTooLarge = discount > subtotal;
  const net = discountTooLarge ? subtotal : subtotal - discount;
  const service = input.type === 'dine_in' ? percentMinor(net, input.serviceRate) : 0n;
  const tax = percentMinor(net + service, input.taxRate);
  return {
    subtotal: fromMinor(subtotal),
    discount: fromMinor(discountTooLarge ? 0n : discount),
    service: fromMinor(service),
    tax: fromMinor(tax),
    total: fromMinor(net + service + tax),
    discountTooLarge,
  };
}
