import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingExcludes: {
    "*": ["node_modules/typescript/**"],
  },
};

export default nextConfig;
