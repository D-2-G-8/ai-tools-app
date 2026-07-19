import Link from "next/link";
import { notFound } from "next/navigation";
import { getTool } from "@/lib/tools/registry";

export default async function ToolLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ toolKey: string }>;
}) {
  const { toolKey } = await params;
  const tool = getTool(toolKey);
  if (!tool) notFound();

  const tabs = [
    { href: `/tools/${toolKey}`, label: "Run" },
    { href: `/tools/${toolKey}/prompts`, label: "Prompts" },
    { href: `/tools/${toolKey}/stats`, label: "Stats" },
  ];

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">{tool.name}</h1>
        <p className="mt-1 text-neutral-500">{tool.description}</p>
      </div>

      <div className="flex gap-1 border-b border-neutral-200">
        {tabs.map((tab) => (
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
