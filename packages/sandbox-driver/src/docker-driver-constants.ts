/**
 * Shared constants used by docker-driver.ts + workspace-prep.ts.
 * Lives in its own file so workspace-prep can import them without
 * pulling docker-driver's execa dependency into the test surface for
 * pure-fs helpers.
 */

export const CONTAINER_WORKSPACE = '/workspace';
export const SANDBOX_UID = '1001';
export const SANDBOX_GID = '1001';
