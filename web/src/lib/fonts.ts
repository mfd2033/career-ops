import localFont from "next/font/local";

// Body / UI — Inter. Self-hosted from Fontsource woff2 (public/fonts) so the
// production build never needs to reach fonts.googleapis.com — required for
// the offline/air-gapped build that the career-dashboard-ui.exe packager runs.
// (The src array is spelled out literally: Turbopack's next/font/local plugin
// can only statically analyse a literal list, not a generated one.)
export const inter = localFont({
  src: [
    { path: "../../public/fonts/inter-latin-100-normal.woff2", weight: "100", style: "normal" },
    { path: "../../public/fonts/inter-latin-200-normal.woff2", weight: "200", style: "normal" },
    { path: "../../public/fonts/inter-latin-300-normal.woff2", weight: "300", style: "normal" },
    { path: "../../public/fonts/inter-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/inter-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/inter-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../public/fonts/inter-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "../../public/fonts/inter-latin-800-normal.woff2", weight: "800", style: "normal" },
    { path: "../../public/fonts/inter-latin-900-normal.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});

// Editorial display — Instrument Serif. The home uses it for the hero display
// copy and section headings (the "career-ops" editorial voice). Regular +
// italic (pull-quotes) mirror the docs lib/fonts.ts.
export const instrumentSerif = localFont({
  src: [
    {
      path: "../../public/fonts/instrument-serif-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
  ],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const instrumentSerifItalic = localFont({
  src: [
    {
      path: "../../public/fonts/instrument-serif-latin-400-italic.woff2",
      weight: "400",
      style: "italic",
    },
  ],
  variable: "--font-instrument-serif-italic",
  display: "swap",
});
