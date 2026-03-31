export {};

const baseUrl = process.env.BASE_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim();
const adminKey = process.env.NODE_ADMIN_KEY?.trim() || "";
const agentId = process.env.AGENT_ID?.trim() || "";
const sessionCookie = process.env.SESSION_COOKIE?.trim() || "";
const publicProfileUsername = process.env.PUBLIC_PROFILE_USERNAME?.trim() || "";

if (!baseUrl) {
  console.error("Missing BASE_URL. Example: BASE_URL=https://b.rivr.social pnpm federation:verify:e2e");
  process.exit(1);
}

type CheckResult = {
  name: string;
  ok: boolean;
  status?: number;
  detail?: string;
};

async function main() {
  const checks: CheckResult[] = [];

  checks.push(await expectStatus("manifest public", `${baseUrl}/api/federation/manifest`, [200]));
  checks.push(await expectStatus("registry list public", `${baseUrl}/api/federation/registry`, [200]));
  checks.push(await expectStatus("status gated", `${baseUrl}/api/federation/status`, [401]));
  checks.push(await expectStatus("myprofile gated", `${baseUrl}/api/myprofile`, [401]));
  checks.push(await expectStatus("myprofile manifest gated", `${baseUrl}/api/myprofile/manifest`, [401]));

  if (adminKey) {
    checks.push(
      await expectStatus("status with admin key", `${baseUrl}/api/federation/status`, [200], {
        headers: { "X-Node-Admin-Key": adminKey },
      }),
    );
  } else {
    checks.push({
      name: "status with admin key",
      ok: false,
      detail: "Skipped: NODE_ADMIN_KEY not provided",
    });
  }

  if (agentId) {
    checks.push(
      await expectStatus(
        "registry resolve agent",
        `${baseUrl}/api/federation/registry?agentId=${encodeURIComponent(agentId)}`,
        [200],
      ),
    );
    checks.push(
      await expectStatus(
        "query agent",
        `${baseUrl}/api/federation/query?queryName=agent&targetAgentId=${encodeURIComponent(agentId)}`,
        [200],
      ),
    );
    checks.push(
      await expectStatus(
        "query resources",
        `${baseUrl}/api/federation/query?queryName=resources&targetAgentId=${encodeURIComponent(agentId)}`,
        [200],
      ),
    );
  } else {
    checks.push({
      name: "agent resolution/query",
      ok: false,
      detail: "Skipped: AGENT_ID not provided",
    });
  }

  if (publicProfileUsername) {
    const encodedUsername = encodeURIComponent(publicProfileUsername);
    checks.push(
      await expectStatus(
        "public profile bundle",
        `${baseUrl}/api/profile/${encodedUsername}`,
        [200],
      ),
    );
    checks.push(
      await expectStatus(
        "public profile manifest",
        `${baseUrl}/api/profile/${encodedUsername}/manifest`,
        [200],
      ),
    );
  } else {
    checks.push({
      name: "public profile contract",
      ok: false,
      detail: "Skipped: PUBLIC_PROFILE_USERNAME not provided",
    });
  }

  if (sessionCookie) {
    checks.push(
      await expectStatus("myprofile authenticated", `${baseUrl}/api/myprofile`, [200], {
        headers: { Cookie: sessionCookie },
      }),
    );
    checks.push(
      await expectStatus("myprofile manifest authenticated", `${baseUrl}/api/myprofile/manifest`, [200], {
        headers: { Cookie: sessionCookie },
      }),
    );
  } else {
    checks.push({
      name: "myprofile authenticated",
      ok: false,
      detail: "Skipped: SESSION_COOKIE not provided",
    });
    checks.push({
      name: "myprofile manifest authenticated",
      ok: false,
      detail: "Skipped: SESSION_COOKIE not provided",
    });
  }

  const failures = checks.filter((check) => !check.ok);

  for (const check of checks) {
    const prefix = check.ok ? "PASS" : "FAIL";
    const parts = [prefix, check.name];
    if (typeof check.status === "number") parts.push(`status=${check.status}`);
    if (check.detail) parts.push(check.detail);
    console.log(parts.join(" | "));
  }

  if (failures.length > 0) {
    process.exit(1);
  }

  console.log("Federation end-to-end verification passed.");
}

async function expectStatus(
  name: string,
  url: string,
  expected: number[],
  init?: RequestInit,
): Promise<CheckResult> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    return {
      name,
      ok: expected.includes(response.status),
      status: response.status,
      detail: summarize(text),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : "Request failed",
    };
  }
}

function summarize(body: string): string {
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (!trimmed) return "empty body";
  return trimmed.slice(0, 160);
}

await main();
