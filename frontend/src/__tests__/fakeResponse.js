/**
 * Re-readable stand-in for a fetch Response: JSON bodies carry application/json (the API client only parses those),
 * `raw` bodies (proxy pages) and missing bodies are text/html.
 */
export function fakeResponse(status, body, { raw, type } = {}) {
  const text = raw !== undefined ? raw : (body === undefined ? '<html></html>' : JSON.stringify(body));
  const contentType = type ?? (raw !== undefined || body === undefined ? 'text/html' : 'application/json');
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'Content-Type': contentType }),
    json: async () => JSON.parse(text),
    text: async () => text,
    clone: () => res
  };
  return res;
}

export const htmlResponse = (status, html = '<html>proxy</html>') => fakeResponse(status, undefined, { raw: html });
