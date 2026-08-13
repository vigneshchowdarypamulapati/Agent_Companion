import { createClerkClient, verifyToken } from '@clerk/backend';

export interface VerifiedIdentity {
  clerkUserId: string;
  email: string;
}

export interface IdentityVerifier {
  verifyToken(clerkToken: string): Promise<VerifiedIdentity | undefined>;
}

/**
 * Test double: a fixed map from token string to the identity it represents,
 * with no real Clerk calls. Used by every test that needs an authenticated
 * browser without depending on a live Clerk project.
 */
export class FakeIdentityVerifier implements IdentityVerifier {
  constructor(private identities: Map<string, VerifiedIdentity>) {}

  async verifyToken(clerkToken: string): Promise<VerifiedIdentity | undefined> {
    return this.identities.get(clerkToken);
  }
}

/**
 * Verifies a Clerk session token's signature, then fetches the user's
 * primary email via the Backend API — the default Clerk session token
 * claims don't include email unless the dashboard's session-token template
 * is customized, and requiring every deployment to remember that manual
 * dashboard step is a footgun. This is a one-time call at browser
 * registration, not on the hot request path, so the extra round trip costs
 * nothing that matters.
 */
export class ClerkIdentityVerifier implements IdentityVerifier {
  private client: ReturnType<typeof createClerkClient>;

  constructor(private secretKey: string) {
    this.client = createClerkClient({ secretKey });
  }

  async verifyToken(clerkToken: string): Promise<VerifiedIdentity | undefined> {
    let clerkUserId: string;
    try {
      const claims = await verifyToken(clerkToken, { secretKey: this.secretKey });
      clerkUserId = claims.sub;
    } catch {
      return undefined;
    }
    const user = await this.client.users.getUser(clerkUserId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    return { clerkUserId, email: primary?.emailAddress ?? '' };
  }
}
