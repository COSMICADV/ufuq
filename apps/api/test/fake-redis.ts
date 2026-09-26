/**
 * A minimal in-memory stand-in for the three `ioredis` calls
 * `RateLimitService` makes. Not a general Redis mock — just enough to
 * exercise the real fixed-window rate-limit logic without a real Redis
 * connection, which this sandbox has no way to provide (AD-01's real Redis
 * runs in `docker-compose.yml`, unavailable here — see the Phase 3 report).
 */
export class FakeRedis {
  private readonly counts = new Map<string, number>();
  private readonly expiresAt = new Map<string, number>();

  private isExpired(key: string): boolean {
    const expiry = this.expiresAt.get(key);
    return expiry !== undefined && expiry <= Date.now();
  }

  async incr(key: string): Promise<number> {
    if (this.isExpired(key)) {
      this.counts.delete(key);
      this.expiresAt.delete(key);
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expiresAt.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const expiry = this.expiresAt.get(key);
    if (expiry === undefined) return -1;
    return Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  reset(): void {
    this.counts.clear();
    this.expiresAt.clear();
  }
}
