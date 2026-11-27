/** An actionable, secret-free diagnosis for a common OpenAI-compatible gateway misconfiguration. */
export class GatewayHtmlResponseError extends Error {
  constructor(baseUrl: string) {
    super(
      `The gateway at ${baseUrl} returned HTML, not JSON — check the Base URL (it usually must end in /v1) and that this is an OpenAI-compatible API endpoint.`,
    );
  }
}

/**
 * Parse a 2xx gateway response without ever reflecting an HTML login/proxy page into an error.
 * The complete body can contain account information; a stable explanation is both safer and more useful.
 */
export function parseGatewayJson(body: string, baseUrl: string): unknown {
  if (body.trimStart().startsWith('<')) {
    throw new GatewayHtmlResponseError(baseUrl);
  }
  return JSON.parse(body);
}
