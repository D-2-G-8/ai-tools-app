export function SetupNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">Environment is not set up yet</p>
      <p className="mt-1">{message}</p>
      <p className="mt-2 text-amber-700">Check README.md — it has step-by-step setup instructions.</p>
    </div>
  );
}
