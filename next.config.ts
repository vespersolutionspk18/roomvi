import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp is auto-externalized by Next 16, but we import it from the worker
  // process too and want the same resolution behaviour in both.
  serverExternalPackages: ["sharp", "pg"],
  turbopack: {
    // The app is its own git repo nested inside C:\Code Projects, so Turbopack's
    // root inference walks up past it and finds a stray lockfile. Pin it.
    root: __dirname,
  },
};

export default nextConfig;
