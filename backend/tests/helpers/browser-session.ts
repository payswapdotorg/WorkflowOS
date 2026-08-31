import type { Page } from '@playwright/test';

/**
 * WORK-074 — seed a REAL server-side session for the browser E2E specs.
 *
 * The demo-key localStorage login is RETIRED from the frontend (the WORK-063
 * invariant #9): the production transport is the HttpOnly `wfos_session`
 * cookie verified against wfos_sessions. The specs seed the session through
 * the SAME SessionService the /auth routes use and attach the cookie to the
 * browser context — the specs then exercise the true authenticated transport.
 */
export async function loginWithServerSession(
  page: Page,
  sessionService: {
    create(input: { userId: string; provider: string }): Promise<{ token: string }>;
  },
  userId: string,
): Promise<void> {
  const created = await sessionService.create({ userId, provider: 'password' });
  await page.context().addCookies([
    {
      name: 'wfos_session',
      value: created.token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
