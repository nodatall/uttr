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

  return null;
}

function readCookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }

  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]+)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export function readSupabaseAccessTokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim() || null;
  }

  const cookieHeader = request.headers.get("cookie");
  const cookieToken = readCookieValue(cookieHeader, "sb-access-token");
  if (cookieToken) {
    return cookieToken;
  }

  return null;
}
