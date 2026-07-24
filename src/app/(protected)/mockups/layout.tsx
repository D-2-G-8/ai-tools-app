export default function MockupsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Mockups</h1>
        <p className="mt-1 text-neutral-500">
          App screens imported from Figma and rebuilt on the design system.
        </p>
      </div>
      {children}
    </div>
  );
}
