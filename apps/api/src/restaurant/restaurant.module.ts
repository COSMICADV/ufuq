import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';

import { AuthModule } from '../auth/auth.module.js';

import { RestaurantMenuService, MAX_MENU_IMAGE_BYTES } from './menu.service.js';
import { RestaurantOrdersService } from './orders.service.js';
import { RestaurantController } from './restaurant.controller.js';
import { RestaurantEvents } from './restaurant-events.js';
import { RestaurantSetupService } from './setup.service.js';

/**
 * 1to1OS Business — Restaurants & Cafés (phase R1: branches, team, visual
 * menu, tables, POS orders, kitchen display, waiter and pickup hand-over,
 * live updates). Menu photos use the process-wide private bucket; one small
 * file per upload, kept in memory, never written to disk.
 */
@Module({
  imports: [
    AuthModule,
    MulterModule.register({
      limits: { fileSize: MAX_MENU_IMAGE_BYTES + 1, files: 1, fields: 2, parts: 3, fieldSize: 64 },
    }),
  ],
  controllers: [RestaurantController],
  providers: [
    RestaurantSetupService,
    RestaurantMenuService,
    RestaurantOrdersService,
    RestaurantEvents,
  ],
})
export class RestaurantModule {}
