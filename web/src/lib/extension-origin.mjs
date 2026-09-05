// Trusted BOSS直聘 extension identity — the single binding point between the
// MV3 extension's fixed `key` (extension/manifest.json, derive-tool
// extension/tools/generate-key-id.mjs) and the backend's cross-site pass in
// origin-guard.mjs. If the extension key is ever regenerated, update this too
// or the extension's local /api requests land on 403.

/** The manifest-fixed MV3 extension ID (derived from the extension `key`). */
export const EXTENSION_ID = "fplgidebccliinljlhipjiinoeeffeep";

/** The full chrome-extension:// Origin the backend recognizes as trusted. */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;