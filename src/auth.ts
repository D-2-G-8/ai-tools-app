import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { user, account, session, verificationToken } from "@/db/schema";

/**
 * Auth.js (NextAuth v5) setup. Used everywhere -- Server Components, Server
 * Actions, and the route handler below all run in the Node.js runtime by
 * default, so it's safe for this to use the Drizzle adapter (backed by the
 * `postgres` package, a raw TCP client that does NOT work in the Vercel Edge
 * runtime). There is deliberately no middleware.ts: access control lives in
 * src/app/(protected)/layout.tsx instead, a plain async Server Component
 * that does a fresh DB read on every render — see that file for why (no
 * Edge-safe split-config/session-update-trigger complexity needed).
 *
 * `session.user.id` is the only thing cached in the JWT (see the jwt/session
 * callbacks below) -- companyId/companyRole are deliberately NOT cached
 * here; every place that needs them calls src/db/users.ts's
 * getCurrentUser(), which always reads the current row from the DB. That
 * avoids any stale-token window right after onboarding (creating/joining a
 * company) without needing an explicit session-refresh call.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: user,
    accountsTable: account,
    sessionsTable: session,
    verificationTokensTable: verificationToken,
  }),
  providers: [Google],
  session: { strategy: "jwt" },
  // Vercel is auto-detected as a trusted host by Auth.js, but this is set
  // explicitly too so local dev (and any other self-hosted deploy target)
  // doesn't hit Auth.js's UntrustedHost check (see errors.authjs.dev#untrustedhost).
  trustHost: true,
  pages: { signIn: "/sign-in" },
  callbacks: {
    async jwt({ token, user: authUser }) {
      if (authUser) token.userId = authUser.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.userId) {
        session.user.id = token.userId as string;
      }
      return session;
    },
  },
});
