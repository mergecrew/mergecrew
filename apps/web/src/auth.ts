import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import { headers } from 'next/headers';
import { resolveVerifiedEmail } from '@/lib/oauth-email';
import { bffTrustToken } from '@/lib/secrets';
import { clientIpFromHeaders } from '@/lib/auth-cookies';

const API_BASE = () => process.env.API_BASE_URL ?? 'http://localhost:4000';

async function clientIp(): Promise<string | null> {
  try {
    return clientIpFromHeaders(await headers());
  } catch {
    return null;
  }
}

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
  pages: { signIn: '/login', error: '/login' },
  callbacks: {
    /**
     * Only accept sign-ins whose email the provider has verified (Google
     * `email_verified`; GitHub verified + primary from /user/emails). The
     * API links accounts by email, so an unverified address must never
     * reach /v1/auth/exchange.
     */
    async signIn({ account, profile }) {
      const email = await resolveVerifiedEmail(account, profile);
      return email ? true : '/login?error=unverified_email';
    },
    async jwt({ token, account, profile }) {
      // On first sign in, exchange the *verified* email for a Mergecrew
      // API JWT. The token lives only in NextAuth's encrypted, httpOnly
      // session cookie; it is read server-side (lib/session.ts) and never
      // exposed through the session callback / /api/auth/session.
      if (account) {
        delete token.mergecrewJwt;
        delete token.mergecrewMfaToken;
        const email = await resolveVerifiedEmail(account, profile);
        if (!email) return token;
        token.email = email;
        try {
          const ip = await clientIp();
          const r = await fetch(`${API_BASE()}/v1/auth/exchange`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(ip ? { 'x-forwarded-for': ip } : {}),
            },
            body: JSON.stringify({
              email,
              name: token.name ?? profile?.name,
              avatarUrl: token.picture,
              trustToken: bffTrustToken(),
            }),
            cache: 'no-store',
          });
          if (r.ok) {
            const j = (await r.json()) as
              | { token: string; user: { id: string } }
              | { mfaRequired: true; mfaToken: string; user: { id: string } };
            token.mergecrewUserId = j.user.id;
            if ('mfaRequired' in j && j.mfaRequired) {
              // MFA-enrolled: no session until /login/mfa passes.
              token.mergecrewMfaToken = j.mfaToken;
            } else if ('token' in j) {
              token.mergecrewJwt = j.token;
            }
          }
        } catch {
          /* ignore — no API session; the user lands back on /login */
        }
      }
      return token;
    },
    async session({ session, token }) {
      // Deliberately no API JWT here: this object is served to browser JS
      // at /api/auth/session.
      (session as any).mergecrewUserId = token.mergecrewUserId;
      return session;
    },
  },
});
