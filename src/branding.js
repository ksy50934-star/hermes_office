function configured(name, fallback) {
  const value = String(import.meta.env?.[name] ?? "").trim();
  return value || fallback;
}

export const OFFICE_BRAND_NAME = configured("VITE_OFFICE_BRAND_NAME", "Hermes Office");
export const OFFICE_BRAND_SHORT_NAME = configured("VITE_OFFICE_BRAND_SHORT_NAME", "Hermes");
export const OFFICE_BRAND_DESCRIPTION = configured(
  "VITE_OFFICE_BRAND_DESCRIPTION",
  "Self-hosted AI team workspace",
);

export const OFFICE_BRAND_MARK = OFFICE_BRAND_SHORT_NAME.toUpperCase();
export const OFFICE_WORKSPACE_LABEL = `${OFFICE_BRAND_MARK} WORKSPACE`;

/**
 * The sidebar mark. It deliberately avoids a `/hermes…` path: the dev and
 * preview servers proxy that prefix to the local Hermes backend, so a file
 * named that way is never served from `public/` and renders as a broken image.
 * The lockup still falls back to a text mark if this asset ever goes missing.
 */
export const OFFICE_BRAND_MARK_SRC = "/agent-office-mark.svg";
