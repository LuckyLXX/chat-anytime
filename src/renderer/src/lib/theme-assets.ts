import type { ThemeAssetMap } from "../../../shared/protocol";

export const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/giu;

export function normalizeThemeAssetReference(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+?/u, "").toLowerCase();
}

export function isExternalThemeReference(reference: string): boolean {
  return !reference || /^(?:data:|https?:|file:|blob:|var\(|#)/iu.test(reference);
}

/** Replace relative theme paths with short runtime URLs instead of huge data URLs. */
export function resolveThemeAssets(css: string, assets: ThemeAssetMap | undefined): string {
  if (!assets || Object.keys(assets).length === 0) return css;
  return css.replace(CSS_URL_PATTERN, (match, _quote: string, rawReference: string) => {
    const reference = normalizeThemeAssetReference(rawReference);
    const assetUrl = assets[reference];
    return assetUrl && !isExternalThemeReference(reference) ? `url("${assetUrl}")` : match;
  });
}

function dataUrlToBlob(dataUrl: string): Blob | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/iu.exec(dataUrl.trim());
  if (!match) return undefined;
  try {
    const encoded = match[2];
    if (encoded === undefined) return undefined;
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1] });
  } catch {
    return undefined;
  }
}

export interface ThemeAssetUrlSet {
  urls: ThemeAssetMap;
  revoke(): void;
}

export function createThemeAssetUrls(assets: ThemeAssetMap | undefined): ThemeAssetUrlSet {
  const urls: ThemeAssetMap = {};
  const createdUrls: string[] = [];
  if (!assets || typeof URL.createObjectURL !== "function") return { urls, revoke: () => undefined };

  for (const [path, dataUrl] of Object.entries(assets)) {
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    urls[normalizeThemeAssetReference(path)] = url;
    createdUrls.push(url);
  }

  return {
    urls,
    revoke: () => createdUrls.forEach((url) => URL.revokeObjectURL(url))
  };
}
