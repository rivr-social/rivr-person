import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDomain = process.env.NEXT_PUBLIC_DOMAIN;
const publicAssetBaseUrl = process.env.ASSET_PUBLIC_BASE_URL?.trim() || process.env.NEXT_PUBLIC_MINIO_URL?.trim();

const extraImageDomains = (process.env.NEXT_PUBLIC_IMAGE_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim())
  .filter((domain) => domain.length > 0);

function toRemotePattern(urlValue: string) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      protocol: parsed.protocol.replace(":", "") as "http" | "https",
      hostname: parsed.hostname,
      ...(parsed.port ? { port: parsed.port } : {}),
      pathname: "/**",
    };
  } catch {
    return null;
  }
}

const publicAssetPattern = publicAssetBaseUrl ? toRemotePattern(publicAssetBaseUrl) : null;
const staticRemotePatterns = [
  {
    protocol: "https" as const,
    hostname: "s3.rivr.social",
    pathname: "/**",
  },
  {
    protocol: "https" as const,
    hostname: "matrix.rivr.social",
    pathname: "/**",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Raise the request-body cap for /api/upload (.glb avatars up to 50MB).
  // Default is 10MB and middleware truncates the body before the route sees
  // it, surfacing as misleading 400 Bad Request from a half-parsed multipart
  // body. See https://nextjs.org/docs/app/api-reference/config/next-config-js/middlewareClientMaxBodySize
  middlewareClientMaxBodySize: 100 * 1024 * 1024,
  experimental: {
    staleTimes: { dynamic: 0, static: 0 },
    // Mirror for server actions (separate code path from route handlers).
    serverActions: { bodySizeLimit: "100mb" },
    // Next 15 still reads this from experimental even though there's a
    // top-level alias — leaving it default (10MB) silently truncates
    // .glb avatar uploads via /api/upload.
    middlewareClientMaxBodySize: 100 * 1024 * 1024,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  outputFileTracingRoot: path.join(__dirname, "./"),
  images: {
    dangerouslyAllowSVG: true,
    remotePatterns: [
      ...staticRemotePatterns,
      {
        protocol: "http",
        hostname: "localhost",
        port: "9000",
        pathname: "/**",
      },
      {
        protocol: "http",
        hostname: "minio",
        port: "9000",
        pathname: "/**",
      },
      // Production MinIO (s3.DOMAIN)
      ...(publicDomain
        ? [{ protocol: "https" as const, hostname: `s3.${publicDomain}`, pathname: "/**" }]
        : []),
      // Matrix avatar URLs (matrix.DOMAIN)
      ...(publicDomain
        ? [{ protocol: "https" as const, hostname: `matrix.${publicDomain}`, pathname: "/**" }]
        : []),
      ...(publicAssetPattern ? [publicAssetPattern] : []),
      ...extraImageDomains.map((hostname) => ({
        protocol: "https" as const,
        hostname,
        pathname: "/**",
      })),
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // CSP is set per-request in middleware.ts with a unique nonce
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(self), payment=(), usb=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
