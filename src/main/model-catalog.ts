export interface CatalogAuthStatus {
  configured: boolean;
  source?: string;
}

/**
 * Environment variables are inherited by Electron and are not an explicit
 * model configuration in PiDesktop. Keep them out of the desktop catalog so
 * a host shell cannot silently add an entire provider's model list.
 */
export function isDesktopConfiguredProvider(auth: CatalogAuthStatus | undefined): boolean {
  return auth?.configured === true && auth.source !== "environment";
}
