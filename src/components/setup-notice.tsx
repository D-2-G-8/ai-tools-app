export function SetupNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">Окружение ещё не настроено</p>
      <p className="mt-1">{message}</p>
      <p className="mt-2 text-amber-700">Проверь README.md — там пошаговая инструкция по настройке.</p>
    </div>
  );
}
