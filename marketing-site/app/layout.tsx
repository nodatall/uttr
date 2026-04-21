import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { AgentationDevToolbar } from "@/components/agentation-dev-toolbar";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Uttr | Beautiful speech-to-text for your desktop",
  description:
    "Speak. It becomes text. Uttr is a clean, beautiful desktop speech-to-text app with fast local transcription.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body
        className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} bg-cosmic-950 font-display text-cosmic-50 antialiased`}
      >
        {children}
        <AgentationDevToolbar />
      </body>
    </html>
  );
}
