import assert from "node:assert/strict";
import test from "node:test";
import {
  canUserAccessChatChannel,
  isMatchingInternalChatMessageReplay,
  resolveAccessibleChatChannelFromCandidates,
  selectActiveWorkspaceMembership,
  type AccessibleChatChannel,
} from "./channelCommandService";

function channel(
  overrides: Partial<AccessibleChatChannel> = {},
): AccessibleChatChannel {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "workspace-1",
    kind: "channel",
    name: "General",
    slug: "general",
    displayName: "General",
    visibility: "workspace",
    isArchived: false,
    ...overrides,
  };
}

test("access mirrors Team Chat RLS and never grants implicit DM access", () => {
  assert.equal(
    canUserAccessChatChannel({
      userId: "admin-1",
      workspaceRole: "admin",
      channel: {
        kind: "dm",
        visibility: "private",
        createdBy: "admin-1",
      },
      isExplicitMember: false,
    }),
    false,
  );
  assert.equal(
    canUserAccessChatChannel({
      userId: "guest-1",
      workspaceRole: "guest",
      channel: {
        kind: "channel",
        visibility: "private",
        createdBy: "guest-1",
      },
      isExplicitMember: false,
    }),
    true,
  );
  assert.equal(
    canUserAccessChatChannel({
      userId: "member-1",
      workspaceRole: "member",
      channel: {
        kind: "channel",
        visibility: "workspace",
        createdBy: "other-user",
      },
      isExplicitMember: false,
    }),
    true,
  );
  assert.equal(
    canUserAccessChatChannel({
      userId: "guest-1",
      workspaceRole: "guest",
      channel: {
        kind: "channel",
        visibility: "workspace",
        createdBy: "other-user",
      },
      isExplicitMember: false,
    }),
    false,
  );
  assert.equal(
    canUserAccessChatChannel({
      userId: "guest-1",
      workspaceRole: "guest",
      channel: {
        kind: "dm",
        visibility: "private",
        createdBy: "other-user",
      },
      isExplicitMember: true,
    }),
    true,
  );
  assert.equal(
    canUserAccessChatChannel({
      userId: "former-user",
      workspaceRole: null,
      channel: {
        kind: "channel",
        visibility: "workspace",
        createdBy: "former-user",
      },
      isExplicitMember: true,
    }),
    false,
  );
});

test("active workspace selection honors a valid preference without repairing state", () => {
  const memberships = [
    { workspaceId: "workspace-a", role: "member" as const },
    { workspaceId: "workspace-b", role: "admin" as const },
  ];
  assert.deepEqual(
    selectActiveWorkspaceMembership({
      memberships,
      preferredWorkspaceId: "workspace-a",
      ownedWorkspaceIds: ["workspace-b"],
    }),
    memberships[0],
  );
  assert.deepEqual(
    selectActiveWorkspaceMembership({
      memberships,
      preferredWorkspaceId: "stale-workspace",
      ownedWorkspaceIds: ["workspace-b"],
    }),
    memberships[1],
  );
});

test("resolver supports id, #slug, name, and viewer-specific DM display name", () => {
  const general = channel();
  const dm = channel({
    id: "22222222-2222-4222-8222-222222222222",
    kind: "dm",
    name: "Legacy DM label",
    slug: "dm-222",
    displayName: "Alex Rivera",
    visibility: "private",
  });
  for (const [query, expectedId] of [
    [general.id, general.id],
    ["#GENERAL", general.id],
    ["General", general.id],
    ["alex rivera", dm.id],
  ]) {
    const result = resolveAccessibleChatChannelFromCandidates({
      channels: [dm, general],
      query,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.channel.id, expectedId);
  }
});

test("resolver reports accessible duplicate names deterministically", () => {
  const alpha = channel({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "ops-a",
    name: "Ops",
    displayName: "Ops",
  });
  const beta = channel({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    slug: "ops-b",
    name: "Ops",
    displayName: "Ops",
  });
  const result = resolveAccessibleChatChannelFromCandidates({
    channels: [beta, alpha],
    query: "ops",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous");
  if (result.reason === "ambiguous") {
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id),
      [alpha.id, beta.id],
    );
  }
});

test("resolver falls back to a unique prefix and then a unique contains match", () => {
  const engineering = channel({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "engineering",
    name: "Engineering",
    displayName: "Engineering",
  });
  const alex = channel({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind: "dm",
    slug: "dm-alex",
    name: "Legacy label",
    displayName: "Alex Rivera",
    visibility: "private",
  });
  const prefix = resolveAccessibleChatChannelFromCandidates({
    channels: [alex, engineering],
    query: "engin",
  });
  assert.equal(prefix.ok, true);
  if (prefix.ok) assert.equal(prefix.channel.id, engineering.id);

  const contains = resolveAccessibleChatChannelFromCandidates({
    channels: [engineering, alex],
    query: "river",
  });
  assert.equal(contains.ok, true);
  if (contains.ok) assert.equal(contains.channel.id, alex.id);
});

test("ambiguous fuzzy matches return at most five authorized candidates", () => {
  const channels = Array.from({ length: 7 }, (_, index) =>
    channel({
      id: `${index + 1}0000000-0000-4000-8000-000000000000`,
      slug: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      displayName: `Project ${index + 1}`,
    }),
  );
  const result = resolveAccessibleChatChannelFromCandidates({
    channels: channels.reverse(),
    query: "proj",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous");
  if (result.reason === "ambiguous") {
    assert.equal(result.candidates.length, 5);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.name),
      ["Project 1", "Project 2", "Project 3", "Project 4", "Project 5"],
    );
  }
});

test("active matches win over archived name matches and archived-only matches stay read-only", () => {
  const archived = channel({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "old-general",
    isArchived: true,
  });
  const active = channel({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    slug: "new-general",
  });
  const activeResult = resolveAccessibleChatChannelFromCandidates({
    channels: [archived, active],
    query: "General",
  });
  assert.equal(activeResult.ok, true);
  if (activeResult.ok) assert.equal(activeResult.channel.id, active.id);

  const archivedResult = resolveAccessibleChatChannelFromCandidates({
    channels: [archived],
    query: archived.id,
  });
  assert.equal(archivedResult.ok, false);
  assert.equal(archivedResult.reason, "archived");
});

test("internal replay requires the same actor, channel, content, and client id", () => {
  const row = {
    id: "33333333-3333-4333-8333-333333333333",
    channel_id: "channel-1",
    author_type: "user",
    author_user_id: "user-1",
    content: "Hello team",
    metadata: {
      client_message_id: "33333333-3333-4333-8333-333333333333",
    },
  };
  assert.equal(
    isMatchingInternalChatMessageReplay({
      row,
      channelId: "channel-1",
      userId: "user-1",
      clientMessageId: "33333333-3333-4333-8333-333333333333",
      content: "Hello team",
    }),
    true,
  );
  assert.equal(
    isMatchingInternalChatMessageReplay({
      row,
      channelId: "channel-2",
      userId: "user-1",
      clientMessageId: "33333333-3333-4333-8333-333333333333",
      content: "Hello team",
    }),
    false,
  );
});
