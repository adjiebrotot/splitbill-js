/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native modules webpack cannot bundle: required at runtime from
  // node_modules and traced into the function.
  serverExternalPackages: ["@napi-rs/canvas", "@node-rs/bcrypt", "pg"],
  // Report fonts are read from disk at render time (src/services/report_binary.ts).
  // Only the routes that can emit a PNG/PDF trace them in.
  outputFileTracingIncludes: {
    "/app/api/**": ["./src/assets/fonts/**"],
    "/webhook": ["./src/assets/fonts/**"],
  },
  async headers() {
    const immutable = [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }];
    return [
      { source: "/app/static/css/:path*", headers: immutable },
      { source: "/app/static/js/:path*", headers: immutable },
      { source: "/app/static/assets/:path*", headers: immutable },
      { source: "/app/static/icons/:path*", headers: immutable },
      // The worker must be re-checked on every load or a deploy never lands.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
      { source: "/app/manifest.json", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
    ];
  },
  // Pages are static shells in public/app/static/pages, served by the CDN:
  // no function runs to show a page. The shell fetches its data itself.
  async rewrites() {
    return {
      afterFiles: [
        { source: "/", destination: "/app/static/pages/landing.html" },
        { source: "/login", destination: "/app/static/pages/login.html" },
        { source: "/register", destination: "/app/static/pages/register.html" },
        { source: "/app", destination: "/app/static/pages/home.html" },
        { source: "/app/settings", destination: "/app/static/pages/settings.html" },
        { source: "/app/g/:id([A-Za-z0-9]{4,16})", destination: "/app/static/pages/group.html" },
        { source: "/app/join/:code([A-Za-z0-9]{4,32})", destination: "/app/static/pages/join.html" },
        // Admin console. English only; data comes from /app/api/admin/*, which checks ADMIN_PASSWORD's session.
        { source: "/admin", destination: "/app/static/pages/admin.html" },
      ],
    };
  },
};

export default nextConfig;
