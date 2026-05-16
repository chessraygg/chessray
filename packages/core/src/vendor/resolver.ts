/**
 * Vendor-asset URL resolver.
 *
 * Core code that needs to load vendor assets at runtime (models, WASM, dicts)
 * must go through `vendorUrl(rel)` rather than hardcoding a URL scheme. Each
 * host (Electron, Chrome extension, Node tests) calls `setVendorResolver` at
 * startup to map a relative vendor path (e.g. `paddle-ocr/ppocrv5_en_dict.txt`)
 * to a concrete URL it can fetch — `chess-vendor://...` in Electron,
 * `chrome.runtime.getURL(...)` in the extension, a file URL in Node.
 *
 * The default resolver preserves the historical `chess-vendor://` scheme so
 * Electron works without opting in.
 */

export type VendorResolver = (relPath: string) => string;

let resolver: VendorResolver = (rel) => `chess-vendor://${rel}`;

export function setVendorResolver(fn: VendorResolver): void {
  resolver = fn;
}

export function vendorUrl(relPath: string): string {
  return resolver(relPath);
}
