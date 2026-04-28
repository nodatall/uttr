import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LATEST_RELEASE_API =
  "https://api.github.com/repos/nodatall/uttr/releases/latest";
const FALLBACK_RELEASE_URL = "https://github.com/nodatall/uttr/releases/latest";

type GitHubReleaseAsset = {
  name?: string;
  state?: string;
  browser_download_url?: string;
};

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
};

type MacArch = "aarch64" | "x64";

function readRequestedArch(request: Request): MacArch {
  const url = new URL(request.url);
  const archParam = url.searchParams.get("arch")?.toLowerCase();

  if (archParam === "x64" || archParam === "x86_64" || archParam === "intel") {
    return "x64";
  }

  if (
    archParam === "arm64" ||
    archParam === "aarch64" ||
    archParam === "apple-silicon"
  ) {
    return "aarch64";
  }

  const clientHintArch = request.headers
    .get("sec-ch-ua-arch")
    ?.replaceAll('"', "")
    .toLowerCase();

  if (clientHintArch === "x86" || clientHintArch === "x86_64") {
    return "x64";
  }

  return "aarch64";
}

export function selectMacDmgAsset(
  assets: GitHubReleaseAsset[] | undefined,
  arch: MacArch,
) {
  const dmgAssets = (assets || []).filter((asset) => {
    return (
      asset.state === "uploaded" &&
      typeof asset.name === "string" &&
      asset.name.endsWith(".dmg") &&
      typeof asset.browser_download_url === "string"
    );
  });

  const preferredPattern =
    arch === "x64" ? /_x64\.dmg$/i : /_(aarch64|arm64)\.dmg$/i;

  return (
    dmgAssets.find((asset) => preferredPattern.test(asset.name || "")) ||
    dmgAssets.find((asset) => /_(aarch64|arm64)\.dmg$/i.test(asset.name || "")) ||
    dmgAssets.find((asset) => /_x64\.dmg$/i.test(asset.name || "")) ||
    dmgAssets[0] ||
    null
  );
}

export async function GET(request: Request) {
  const arch = readRequestedArch(request);

  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "uttr-download-route",
      },
      next: { revalidate: 300 },
    });

    if (response.ok) {
      const release = (await response.json()) as GitHubRelease;
      const asset = selectMacDmgAsset(release.assets, arch);

      if (asset?.browser_download_url) {
        return NextResponse.redirect(asset.browser_download_url, {
          status: 302,
          headers: {
            "cache-control": "public, s-maxage=300",
          },
        });
      }
    }

    console.error("download_asset_lookup_failed", {
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    console.error("download_asset_lookup_failed", error);
  }

  return NextResponse.redirect(FALLBACK_RELEASE_URL, { status: 302 });
}
