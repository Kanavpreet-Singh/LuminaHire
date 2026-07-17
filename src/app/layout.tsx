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
  title: "LuminaHire — Agentic HR Tech Platform",
  description:
    "Automate your entire hiring pipeline with agentic AI. LuminaHire screens resumes, matches skills, and conducts outreach so you can focus on interviewing the best talent.",
  keywords: [
    "recruitment",
    "hr tech",
    "ai agents",
    "hiring",
    "resume screening",
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
