import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { PublicSiteService } from './public.service.js';
@Injectable()
export class PublicWriteGuard implements CanActivate {
  constructor(@Inject(PublicSiteService) private readonly service: PublicSiteService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    await this.service.throttle(
      request.path.endsWith('/register') ? 'register' : 'contact',
      request.ip ?? null,
    );
    return true;
  }
}
