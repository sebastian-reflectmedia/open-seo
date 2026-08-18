/** Better Auth provider ID for the dedicated Google Analytics grant. */
export const GA4_OAUTH_PROVIDER_ID = "google-analytics";

// Google hasn't approved the GA4 OAuth app yet, so hosted connect attempts
// show Google's "unverified app" warning. Gates every GA4 connect surface;
// flip to false once the app is approved. Self-hosted deployments use their
// own OAuth app, so only hosted mode is gated.
export const GA4_OAUTH_APP_PENDING = true;

// Google's OAuth verification reviewer tests with this account, so the GA4
// connect/disconnect surfaces stay visible for it while the app is pending
// approval. MCP tool registration stays gated for everyone until approval.
const GA4_OAUTH_REVIEWER_EMAILS = new Set(["walkthrough@everyapp.dev"]);

/** Whether GA4 connect surfaces are visible to this user despite the pending gate. */
export function isGa4ConnectAvailable(
  email: string | null | undefined,
): boolean {
  if (!GA4_OAUTH_APP_PENDING) return true;
  return email != null && GA4_OAUTH_REVIEWER_EMAILS.has(email);
}

export const GA4_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const;

export const GA4_SELF_HOSTED_SETUP_DOCS_URL =
  "https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_ANALYTICS.md";
