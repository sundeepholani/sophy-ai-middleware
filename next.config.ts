import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: {
    // `next dev` logs every Server Function call WITH its arguments by default. The
    // credential cards pass secrets as plain arguments (connectProjectCloudflare's
    // apiToken, connectProjectGateway's apiKey), so the default would print them to the
    // terminal. Incoming-request and fetch logging keep their defaults.
    serverFunctions: false,
  },
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
