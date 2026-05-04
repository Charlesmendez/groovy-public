export type CellStatus = "active" | "paused" | "archived";

export type CellKrStatus =
  | "on_track"
  | "at_risk"
  | "off_track"
  | "not_enough_signal";

export type CellSignalStrength = "high" | "medium" | "low";

export type CellAgentOption = {
  agentId: string;
  name: string;
  agentType: "orchestrator-runtime" | "claude-code";
  shared: boolean;
  ownedByCurrentUser: boolean;
  ownerUserId: string;
  ownerEmail: string | null;
  lastActivityAt: string | null;
  messageCount: number;
  assignedCellId: string | null;
};

export type CellMemberIntegrationState = {
  gmailConnected: boolean;
  calendarConnected: boolean;
  heartbeatEnabled: boolean;
  upreadyConnected: boolean;
};

export type CellMemberHealthSignal = {
  connected: boolean;
  latestScore: number | null;
  latestLoad: number | null;
  trendDelta7d: number | null;
  measuredAt: string | null;
  summary: string;
  label: "strong" | "watch" | "strained" | "unknown";
};

export type CellSignalTypeSummary = {
  key: string;
  label: string;
  count: number;
  confidenceAvg: number | null;
};

export type CellMemberEngagement = {
  score: number;
  label: "high" | "moderate" | "low" | "disengaged";
  breakdown: {
    agentInteraction: number;
    integrationBreadth: number;
    signalQuality: number;
    recency: number;
    wellbeing: number;
  };
};

export type CellMemberSummary = {
  userId: string;
  email: string | null;
  role: "leader" | "member";
  integrations: CellMemberIntegrationState;
  healthSignal: CellMemberHealthSignal;
  engagement: CellMemberEngagement;
  commandCount: number;
  requestCount: number;
  lastSignalAt: string | null;
  lastHeartbeatRunAt: string | null;
  isStale: boolean;
  signalDiversity: number;
  signalStrengthScore: number;
  topSignalTypes: CellSignalTypeSummary[];
};

export type CellModelUsageSummary = {
  provider: string | null;
  model: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  estimatedCalls: number;
};

export type CellEfficiencySummary = {
  label: "efficient" | "expensive_but_productive" | "looping" | "warming_up";
  score: number;
  loopRisk: number;
  tokensPerMeaningfulOutcome: number | null;
  assistantTurnsPerCommand: number | null;
  toolCallsPerMeaningfulOutcome: number | null;
  stalledTraceRate: number;
  repeatPatternRate: number;
  reworkRate: number;
  reasons: string[];
};

export type CellKeyResultSummary = {
  id: string;
  label: string;
  description: string | null;
  measurementMode: "computed" | "hybrid" | "manual";
  evaluationMethod: string | null;
  targetValue: string | null;
  direction: "increase" | "decrease" | "maintain" | "binary";
  status: CellKrStatus;
  confidence: number | null;
  progressPercent: number | null;
  currentValue: string | null;
  evidence: string[];
  updatedAt: string | null;
};

export type CellSummary = {
  id: string;
  name: string;
  objective: string;
  objectiveSummary: string | null;
  status: CellStatus;
  agentId: string;
  agentName: string;
  ownerUserId: string;
  ownerEmail: string | null;
  members: CellMemberSummary[];
  keyResults: CellKeyResultSummary[];
  signalCoverage: {
    humans: number;
    gmailConnected: number;
    calendarConnected: number;
    heartbeatEnabled: number;
    upreadyConnected: number;
    staleMembers: number;
  };
  healthSignal: {
    connectedHumans: number;
    avgLatestScore: number | null;
    avgTrendDelta7d: number | null;
    label: "strong" | "watch" | "strained" | "unknown";
  };
  activity: {
    lastActivityAt: string | null;
    lastAiActionAt: string | null;
    lastHeartbeatAt: string | null;
    userCommands: number;
    assistantTurns: number;
    toolCalls: number;
    meaningfulOutcomes: number;
    pendingInboxActions: number;
    errorRate: number | null;
  };
  efficiency: CellEfficiencySummary;
  updatedAt: string;
};

export type CellTimelineItem = {
  id: string;
  at: string;
  type:
    | "human_command"
    | "team_request"
    | "inbox_action"
    | "assistant_output"
    | "tool_activity"
    | "heartbeat_run"
    | "health_signal";
  actorLabel: string | null;
  title: string;
  detail: string;
  status: string | null;
};

export type CellDetail = {
  summary: CellSummary;
  range: {
    from: string;
    to: string;
  };
  signalTaxonomy: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  signalBreakdown: CellSignalTypeSummary[];
  usageByModel: CellModelUsageSummary[];
  recentSignals: Array<{
    artifactId: string;
    artifactType: string;
    at: string;
    actorLabel: string | null;
    preview: string;
    signalStrength: CellSignalStrength;
    signalTypes: CellSignalTypeSummary[];
  }>;
  timeline: CellTimelineItem[];
  generatedFrameworkMeta: {
    model: string | null;
    generatedAt: string | null;
    generationVersion: string | null;
  };
};
