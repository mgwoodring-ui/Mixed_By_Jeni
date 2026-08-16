import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Continuum — Personal Continuous Mixes",
  description: "Turn your songs into a continuous listening experience."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
