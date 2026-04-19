import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  buildConnectionsRedirectUrl,
  resolveAutobotConnectionScope,
} from "@/lib/autobot-connection-scope";
import {
  buildOAuthAuthorizationUrl,
  buildOAuthState,
  exchangeConnectorOAuthCode,
  getConnectorBaseUrl,
  getOAuthCookiePath,
  getOAuthStateCookieName,
  resolveConnectorAccountIdentity,
  type SupportedOAuthConnectorProvider,
  upsertConnectorOAuthAccount,
} from "@/lib/autobot-oauth-connectors";

export async function handleConnectorOAuthConnect(
  provider: SupportedOAuthConnectorProvider,
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const state = buildOAuthState();
    const authorizationUrl = buildOAuthAuthorizationUrl(provider, state);
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(getOAuthStateCookieName(provider), state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: getOAuthCookiePath(provider),
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "OAuth is not configured on this instance.",
      },
      { status: 503 },
    );
  }
}

export async function handleConnectorOAuthCallback(
  provider: SupportedOAuthConnectorProvider,
  request: Request,
  params: {
    code?: string | null;
    state?: string | null;
    error?: string | null;
  },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }
  const subject = await resolveAutobotConnectionScope(session.user.id);

  const baseUrl = (() => {
    try {
      return getConnectorBaseUrl();
    } catch {
      return "";
    }
  })();

  if (params.error) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, {
        [`${provider}_error`]: params.error,
      }),
    );
  }

  if (!params.code) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, {
        [`${provider}_error`]: "missing_code",
      }),
    );
  }

  const cookies = request.headers.get("cookie") ?? "";
  const stateCookie = cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) =>
      cookie.startsWith(`${getOAuthStateCookieName(provider)}=`),
    );
  const savedState = stateCookie?.split("=")[1];

  if (!savedState || savedState !== params.state) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, {
        [`${provider}_error`]: "state_mismatch",
      }),
    );
  }

  try {
    const tokenData = await exchangeConnectorOAuthCode(provider, params.code);
    const account = await resolveConnectorAccountIdentity(
      provider,
      tokenData.accessToken,
      tokenData,
    );
    await upsertConnectorOAuthAccount(
      subject.actorId,
      provider,
      tokenData,
      account.providerAccountId,
    );

    const response = NextResponse.redirect(buildConnectionsRedirectUrl(baseUrl));
    response.cookies.set(getOAuthStateCookieName(provider), "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 0,
      path: getOAuthCookiePath(provider),
    });
    return response;
  } catch (error) {
    console.error(`${provider} OAuth callback failed:`, error);
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, {
        [`${provider}_error`]: "token_exchange_failed",
      }),
    );
  }
}
