import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_APP_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? '',
    }),
    Google({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    }),
  ],
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    async jwt({ token, account, profile }) {
      // On first sign in, exchange the email for a Mergecrew API JWT.
      if (account && token.email) {
        try {
          const r = await fetch(`${process.env.API_BASE_URL ?? 'http://localhost:4000'}/v1/auth/exchange`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: token.email,
              name: token.name ?? profile?.name,
              avatarUrl: token.picture,
              trustToken: process.env.BFF_TRUST_TOKEN ?? 'dev-trust-token',
            }),
          });
          if (r.ok) {
            const j = (await r.json()) as { token: string; user: { id: string } };
            token.mergecrewJwt = j.token;
            token.mergecrewUserId = j.user.id;
          }
        } catch {
          /* ignore */
        }
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).mergecrewJwt = token.mergecrewJwt;
      (session as any).mergecrewUserId = token.mergecrewUserId;
      return session;
    },
  },
});
