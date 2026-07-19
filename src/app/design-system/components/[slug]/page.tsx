import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { designComponent } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";

export const dynamic = "force-dynamic";

async function loadComponent(slug: string) {
  const workspaceId = await getDefaultWorkspaceId();
  const [component] = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
    .limit(1);
  return component;
}

export default async function DesignComponentDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const component = await loadComponent(slug);
  if (!component) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/design-system/components" className="text-sm text-neutral-500 hover:underline">
          ← Back to components
        </Link>
      </div>

      <div>
        <h2 className="text-xl font-semibold">{component.name}</h2>
        {component.description && <p className="mt-1 text-neutral-600">{component.description}</p>}
      </div>

      {component.variants.length > 0 && (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-medium text-neutral-700">Variants</h3>
          <ul className="flex flex-col gap-2">
            {component.variants.map((variant, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{variant.name}</span>
                {variant.description && <span className="text-neutral-500"> — {variant.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {component.states.length > 0 && (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-medium text-neutral-700">States</h3>
          <ul className="flex flex-col gap-2">
            {component.states.map((state, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{state.name}</span>
                {state.description && <span className="text-neutral-500"> — {state.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {component.notes && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-5">
          <h3 className="mb-2 text-sm font-medium text-amber-800">Notes</h3>
          <p className="text-sm text-amber-900">{component.notes}</p>
        </section>
      )}

      {component.figmaNodeIds.length > 0 && (
        <section className="text-xs text-neutral-400">
          Figma node IDs: {component.figmaNodeIds.join(", ")}
        </section>
      )}
    </div>
  );
}
