const DEFAULT_DOWNLOAD_URL = "/download";
const LEGACY_RELEASES_URL = "https://github.com/nodatall/uttr/releases/latest";

export function getDownloadUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_DOWNLOAD_URL?.trim();

  if (!configuredUrl || configuredUrl.replace(/\/$/, "") === LEGACY_RELEASES_URL) {
    return DEFAULT_DOWNLOAD_URL;
  }

  return configuredUrl;
}
