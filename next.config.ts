import type { NextConfig } from "next";

// "standalone" output is only used for the self-hosted Docker image (see
// Dockerfile) -- it produces a minimal, self-contained server bundle that
// doesn't need the full node_modules copied into the final image layer.
// Gated on DEPLOY_TARGET (set only inside the Dockerfile's builder stage)
// so the Vercel build path stays exactly as it was before this existed.
const isDocker = process.env.DEPLOY_TARGET === "docker";

const nextConfig: NextConfig = {
  output: isDocker ? "standalone" : undefined,
  // Pin the Turbopack filesystem root to this directory. Without this, Next's
  // root inference can pick the wrong directory (this project keeps a
  // pnpm-workspace.yaml only for pnpm build-deps settings, not a real
  // monorepo), which breaks resolving `next` from ./src/app in dev.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
