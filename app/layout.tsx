/**
 * Root layout.
 *
 * Fonts come through `next/font/google` rather than the showroom's `<link>` tags:
 * it self-hosts the files at build time, so there is no render-blocking request
 * to fonts.googleapis.com and no layout shift when the display face arrives.
 *
 * Fraunces is a variable font with an optical-size axis. The showroom uses weight
 * 560 for the wordmark and headings — a non-standard value only a variable font
 * can hit, which is why the axis range is declared rather than a weight list.
 */
import type { Metadata } from "next";
import { Fraunces, Instrument_Sans } from "next/font/google";
import "./globals.css";

const display = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  display: "swap",
});

const body = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "roomvi — see it before you commit",
  description:
    "Upload one room photo, detect its surfaces, and try real materials at true scale.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
