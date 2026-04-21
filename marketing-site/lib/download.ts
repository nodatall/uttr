const FALLBACK_DOWNLOAD_URL =
  "https://github.com/nodatall/uttr/releases/latest";

export function getDownloadUrl() {
  return process.env.NEXT_PUBLIC_DOWNLOAD_URL?.trim() || FALLBACK_DOWNLOAD_URL;
}
