/**
 * Live order events: the moment an order is confirmed or changes status, every
 * open POS, kitchen, waiter and pickup screen of that branch hears about it.
 *
 * An event names the order and its new status only — never items, prices or
 * customers. A screen that hears one asks the API again, through its own
 * permissions, so an event can never show anyone more than they may see.
 *
 * Events travel over Redis pub/sub so every API instance hears every change;
 * with no usable Redis (tests, or Redis down) they stay in this process.
 * Screens also refresh on a timer, so a lost event delays a screen, never
 * loses an order.
 */

import { EventEmitter } from 'node:events';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../common/redis.tokens.js';

import type { OrderStatus, OrderType } from './restaurant-rules.js';

export interface OrderEvent {
  readonly kind: 'created' | 'status' | 'updated';
  readonly company_id: string;
  readonly branch_id: string;
  readonly order_id: string;
  readonly number: number;
  readonly type: OrderType;
  readonly status: OrderStatus;
  readonly waiter_id: string | null;
  readonly at: string;
}

const CHANNEL = 'restaurant:orders';

type Listener = (event: OrderEvent) => void;

@Injectable()
export class RestaurantEvents implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RestaurantEvents.name);
  private readonly local = new EventEmitter();
  private subscriber: Redis | null = null;
  private bridged = false;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    // One listener per open screen; the default warning at 10 is meaningless here.
    this.local.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    const candidate = this.redis as Partial<Redis>;
    if (typeof candidate.duplicate !== 'function' || typeof candidate.publish !== 'function')
      return;
    try {
      const subscriber = this.redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
      subscriber.on('error', (error: Error) => {
        this.logger.warn(`Live order events: Redis subscriber error (${error.message}).`);
      });
      await subscriber.connect();
      await subscriber.subscribe(CHANNEL);
      subscriber.on('message', (_channel: string, message: string) => {
        this.deliver(message);
      });
      this.subscriber = subscriber;
      this.bridged = true;
    } catch (error) {
      this.logger.warn(`Live order events stay in this process: ${(error as Error).message}`);
      this.bridged = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.local.removeAllListeners();
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        // Shutting down; nothing to do.
      }
    }
  }

  /** Called after the change has committed. Never throws: a lost event only delays a screen. */
  async publish(event: OrderEvent): Promise<void> {
    if (this.bridged) {
      try {
        await this.redis.publish(CHANNEL, JSON.stringify(event));
        return;
      } catch (error) {
        this.logger.warn(`Live order event published locally only: ${(error as Error).message}`);
      }
    }
    this.local.emit(event.company_id, event);
  }

  /** Listen to one company's events; returns the function that stops listening. */
  subscribe(companyId: string, listener: Listener): () => void {
    this.local.on(companyId, listener);
    return () => {
      this.local.off(companyId, listener);
    };
  }

  private deliver(message: string): void {
    try {
      const event = JSON.parse(message) as OrderEvent;
      if (typeof event.company_id === 'string') this.local.emit(event.company_id, event);
    } catch {
      // A malformed message is ignored.
    }
  }
}
