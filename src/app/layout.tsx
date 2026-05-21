import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AuthProvider from "@/components/AuthProvider";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "StackMemo — AI-Powered Technical Decision Log",
  description:
    "Capture the 'why' behind your code. StackMemo uses AI to turn raw developer notes into structured, searchable technical context.",
  keywords: [
    "technical decision log",
    "architecture decision record",
    "ADR",
    "knowledge management",
    "developer tools",
    "AI documentation",
  ],
};

import Chatbot from "@/components/Chatbot";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Saira+Stencil:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet" />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <AuthProvider>
          <Navbar />
          <main className="pt-[72px]">{children}</main>
          <Footer />
          <Chatbot />
        </AuthProvider>
      </body>
    </html>
  );
}
