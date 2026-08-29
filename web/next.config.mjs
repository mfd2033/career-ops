/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next dev only whitelists "localhost" by default; 127.0.0.1 is a distinct
  // origin whose dev-only assets (/_next/static/chunks, HMR, fonts) would be
  // blocked, leaving the client app (language toggle, config form) unhydrated.
  allowedDevOrigins: ["127.0.0.1"],
  // Two lockfiles exist on purpose (repo root + web/), so Next would infer the
  // repo root as the workspace root. On Windows that misinference can send
  // Turbopack's postcss workers into an unbounded respawn loop that exhausts
  // all RAM (vercel/next.js#92978) — pin the root to this app.
  turbopack: { root: import.meta.dirname },
  // Allow a throwaway build dir (e.g. BUILD_DIST=.next-prod) so a production
  // `next build` can run without clobbering a live `next dev` .next.
  ...(process.env.BUILD_DIST ? { distDir: process.env.BUILD_DIST } : {}),
  // Opt-in standalone output (WEB_STANDALONE=1) used only by the exe packager —
  // a self-contained server that ships without the dev toolchain. Off by
  // default so a normal `next build` keeps its current output shape.
  ...(process.env.WEB_STANDALONE ? { output: "standalone" } : {}),
};

export default nextConfig;
