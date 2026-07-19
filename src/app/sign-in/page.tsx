import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-8">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-8 text-center">
        <h1 className="text-xl font-semibold">AI Tools Platform</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Sign in with your Google account to continue.
        </p>

        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/onboarding" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700"
          >
            Sign in with Google
          </button>
        </form>
      </div>
    </div>
  );
}
