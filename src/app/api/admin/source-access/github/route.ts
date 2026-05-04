import { NextResponse } from "next/server";
import { isGroovyAdminEmail } from "@/lib/admin/access";
import { getAuthedUser } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  githubUsername?: string;
  repositoryFullName?: string;
  permission?: "pull" | "triage" | "push" | "maintain" | "admin";
};

function defaultSourceRepo(): string {
  return process.env.GITHUB_SOURCE_REPO || "Charlesmendez/groovy";
}

function parseRepo(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo || fullName.split("/").length !== 2) return null;
  return { owner, repo };
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!isGroovyAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const githubUsername = body?.githubUsername?.trim();
  if (!githubUsername) {
    return NextResponse.json({ error: "githubUsername is required" }, { status: 400 });
  }

  const token = process.env.GITHUB_SOURCE_ACCESS_TOKEN?.trim();
  if (!token) {
    return NextResponse.json(
      { error: "Missing GITHUB_SOURCE_ACCESS_TOKEN" },
      { status: 500 }
    );
  }

  const repo = parseRepo(body?.repositoryFullName?.trim() || defaultSourceRepo());
  if (!repo) return NextResponse.json({ error: "Invalid repositoryFullName" }, { status: 400 });

  const permission = body?.permission || "pull";
  const res = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/collaborators/${githubUsername}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission }),
    }
  );

  if (!res.ok) {
    const details = await res.text().catch(() => "");
    return NextResponse.json(
      { error: "GitHub invite failed", status: res.status, details },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    repository: `${repo.owner}/${repo.repo}`,
    githubUsername,
    permission,
  });
}
