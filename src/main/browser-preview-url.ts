const localAddressPattern = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/iu;
const hostWithPortPattern = /^[\w.-]+:\d+(?:[/?#]|$)/iu;

export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("请输入要打开的网址");

  const localAddress = localAddressPattern.test(value);
  const hostWithPort = hostWithPortPattern.test(value);
  const explicitHttp = /^https?:\/\//iu.test(value);
  if (!localAddress && !hostWithPort && !explicitHttp && /^[a-z][a-z\d+.-]*:/iu.test(value)) {
    throw new Error("内置浏览器仅支持 HTTP 和 HTTPS 地址");
  }
  const candidate = explicitHttp ? value : `${localAddress ? "http" : "https"}://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("网址格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("内置浏览器仅支持 HTTP 和 HTTPS 地址");
  }
  return url.toString();
}
