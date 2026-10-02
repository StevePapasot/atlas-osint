export interface InvestigationDetail {
  id: string;
  name: string;
  description: string | null;
  scopeStatement: string | null;
  depth: string;
  mode: 'live' | 'demo';
  modules: string[];
  effectiveModules: string[];
  providers: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  counts: { targets: number; findings: number; entities: number; evidence: number; relationships: number; timeline: number; artifacts: number; reports: number; notes: number; pendingCandidates: number };
  targets: Array<{ id: string; type: string; value: string; normalizedValue: string; label: string | null; metadata: Record<string, unknown>; createdAt: string }>;
  latestJob: JobInfo | null;
}

export interface JobInfo {
  id: string;
  kind: string;
  status: string;
  stage: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  progress: number;
  cancelRequested: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskInfo {
  id: string;
  jobId: string;
  providerId: string;
  operation: string;
  stage: string;
  status: string;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  resultCount: number;
  errorCategory: string | null;
  errorMessage: string | null;
  notes: string[];
  subject: { type: string; display: string; derived: string | null } | null;
  query: string | null;
}

export interface FindingItem {
  id: string;
  entityId: string | null;
  title: string;
  description: string | null;
  category: string;
  claimType: string;
  confidence: string;
  confidenceScore: number;
  confidenceRationale: string[];
  verificationStatus: string;
  sourceCount: number;
  providerCount: number;
  primarySourceUrl: string | null;
  primaryProviderId: string;
  collectedAt: string;
  publishedAt: string | null;
  publishedPrecision: string | null;
  geo: { lat: number | null; lon: number | null; precision: string; place: string | null; country: string | null; basis: string | null } | null;
  bookmarked: boolean;
  isSimulated: boolean;
  entity?: { id: string; type: string | null; display: string | null; value: string | null } | null;
  tags?: Array<{ name: string; color: string }>;
  providers?: string[];
}

export const ACTIVE_STATUSES = ['queued', 'running'];
