import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PublicSiteController } from './public.controller.js';
import { PublicWriteGuard } from './public-write.guard.js';
import { PublicSiteService } from './public.service.js';
@Module({
  imports: [AuthModule],
  controllers: [PublicSiteController],
  providers: [PublicSiteService, PublicWriteGuard],
})
export class PublicSiteModule {}
