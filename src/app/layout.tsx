import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { TOOLS } from "@/lib/tools/registry";

export const metadata: Metadata = {
  title: "AI Tools Platform",
  description: "AI tools platform for the full feature lifecycle",
};

const navItems = [
  { href: "/", label: "Overview" },
  { href: "/documents", label: "Documents" },
  { href: "/design-system", label: "Design System" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex bg-neutral-50 text-neutral-900 font-sans">
        <aside className="w-64 shrink-0 border-r border-neutral-200 bg-white p-4 flex flex-col gap-6">
          <div className="text-lg font-semibold px-2">AI Tools Platform</div>

          <nav className="flex flex-col gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex flex-col gap-1">
            <div className="px-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Tools
            </div>
            {TOOLS.map((tool) => (
              <Link
                key={tool.key}
                href={`/tools/${tool.key}`}
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
              >
                <span>{tool.name}</span>
                {tool.status !== "active" && (
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400">
                    {tool.status === "planned" ? "planned" : "in progress"}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </aside>

        <main className="flex-1 min-w-0 p-8">{children}</main>
      </body>
    </html>
  );
}
