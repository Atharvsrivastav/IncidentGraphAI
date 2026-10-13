import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import { Navigation } from "@/components/layout/Navigation";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IncidentGraph AI — Intelligent SRE Incident Investigation Platform",
  description: "Graph-theoretic microservice topology analysis, cascading failure simulator, and explainable root-cause ranking engine.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-950 text-slate-100 font-sans">
        <Suspense fallback={<div className="h-16 border-b border-slate-800 bg-slate-950" />}>
          <Navigation />
        </Suspense>
        <main className="flex-1 pb-16">{children}</main>
      </body>
    </html>
  );
}
