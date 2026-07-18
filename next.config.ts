import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/boardroom",
  async redirects() {
    return [{ source: "/", destination: "/boardroom", permanent: false, basePath: false }];
  },
  serverExternalPackages: ["pdf-parse", "mammoth"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb"
    }
  }
};

export default nextConfig;
