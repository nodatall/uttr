export function readInstallTokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim() || null;
  }

  const headerToken =
    request.headers.get("install-token") ||
    request.headers.get("install_token");
  if (headerToken) {
    return headerToken.trim() || null;
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("install_token");
  return queryToken?.trim() || null;
}
