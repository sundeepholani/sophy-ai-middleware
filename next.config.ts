import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // KB document uploads go through a Server Action; the default body limit is
    // 1 MB, which would reject anything larger before our handler runs. Raise it
    // to cover the 4 MB per-file cap (lib/files/blob MAX_UPLOAD_BYTES) plus
    // multipart overhead, capped at Vercel's ~4.5 MB function-body ceiling (so we
    // don't advertise headroom the platform won't honor).
    serverActions: { bodySizeLimit: '4.5mb' },
  },
};

export default nextConfig;
