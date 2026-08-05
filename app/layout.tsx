import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gymnastics Scavenger Hunt",
  description: "Private offline gymnastics scavenger-hunt tracker.",
  manifest: "/legacy/manifest.webmanifest",
  icons: {
    icon: "/legacy/assets/favicon-32.png",
    apple: "/legacy/assets/icon-180.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
