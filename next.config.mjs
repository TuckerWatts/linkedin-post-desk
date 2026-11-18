/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pg and pdf-lib run only on the server
    serverComponentsExternalPackages: ["pg", "pdf-lib", "@pdf-lib/fontkit"],
    // Fonts and logo are read from disk when building carousel PDFs
    outputFileTracingIncludes: {
      "/api/**/*": ["./public/fonts/**", "./public/logo-mark.png"],
    },
  },
};

export default nextConfig;
