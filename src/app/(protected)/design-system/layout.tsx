import Link from "next/link";

const TABS = [
  { href: "/design-system", label: "Tokens" },
  { href: "/design-system/components", label: "Components" },
  { href: "/design-system/icons", label: "Icons" },
  { href: "/design-system/mockups", label: "Mockups" },
  { href: "/design-system/settings", label: "Settings" },
];

export default function DesignSystemLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Design System</h1>
        <p className="mt-1 text-neutral-500">
          Tokens and components synced from Figma, plus mockups built from them.
        </p>
      </div>

      <div className="flex gap-1 border-b border-neutral-200">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="rounded-t-md px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-100"
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {children}
    </div>
  );
}
