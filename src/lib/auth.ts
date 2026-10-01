import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authConfig } from "@/auth.config";

/** How often the JWT re-reads role/name from the database (ms). */
const ROLE_REFRESH_MS = 60_000;

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // The role lives in the JWT. Without this, a role change made in Users (STAFF → OWNER) only
    // applied after the person logged out and in again, so the sidebar, module gates and client
    // checks kept the old role. Re-read it from the DB at most once a minute.
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role as string;
        token.name = user.name;
        token.roleCheckedAt = Date.now();
        return token;
      }
      const checkedAt = typeof token.roleCheckedAt === "number" ? token.roleCheckedAt : 0;
      if (token.id && (trigger === "update" || Date.now() - checkedAt > ROLE_REFRESH_MS)) {
        try {
          const fresh = await prisma.user.findUnique({ where: { id: token.id as string }, select: { role: true, name: true, email: true } });
          if (!fresh) {
            // Deleted account: invalidate the session.
            return null;
          }
          token.role = fresh.role;
          token.name = fresh.name;
          token.email = fresh.email;
        } catch { /* keep the cached role when the DB is unreachable */ }
        token.roleCheckedAt = Date.now();
      }
      return token;
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const parsedCredentials = z
          .object({ email: z.string().email(), password: z.string().min(6) })
          .safeParse(credentials);

        if (parsedCredentials.success) {
          const { email, password } = parsedCredentials.data;
          
          const user = await prisma.user.findUnique({ where: { email } });
          if (!user) return null;

          const passwordsMatch = await bcrypt.compare(password, user.password);

          if (passwordsMatch) {
             return user;
          }
        }
        return null;
      },
    }),
  ],
  secret: process.env.AUTH_SECRET,
});
