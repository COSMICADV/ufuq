/**
 * Dependency-injection tokens.
 *
 * Every provider is injected by an explicit token rather than by an emitted
 * constructor-parameter type. Explicit tokens survive `verbatimModuleSyntax`,
 * make the dependency readable at the injection site, and let an interface be
 * a dependency without a class standing in for it.
 */

/** The validated environment, loaded once at bootstrap by @ufuq/config. */
export const APP_ENV = Symbol('ufuq.app.env');

/** Identity of the running service — name and version. */
export const APP_INFO = Symbol('ufuq.app.info');

export interface AppInfo {
  readonly name: string;
  readonly version: string;
}
