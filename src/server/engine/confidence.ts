/**
 * Explainable confidence assessment.
 *
 * ATLAS uses an ordinal rule-points method — NOT a probability. Points:
 *   source reliability: authoritative +3, reputable +2, unknown +1, low 0   (best source counted)
 *   match type:         exact +1, normalized +1, partial 0, fuzzy -1, none -2
 *   corroboration:      +1 per additional independent provider, max +2
 *   claim type:         FACT +1 (directly observed), INFERENCE -1 (derived, not observed)
 *   simulated data:     scored by the same rules (to demonstrate the method) but always flagged SIMULATED
 * Mapping: ≥5 high · 3–4 moderate · 1–2 low · ≤0 unverified.
 * Overrides: UNVERIFIED_LEAD → at most "low" unless corroborated by ≥2 providers; analyst "verified" → verified;
 * analyst "disputed" → at most low; "false_positive" → unverified.
 * Limitations: points are coarse, sources are not truly independent (many aggregate the same upstream data),
 * and source reliability is a per-provider prior rather than a per-claim measurement.
 */
import type { ClaimType, ConfidenceLevel, MatchType, SourceReliability, VerificationStatus } from '@/shared/domain';

export interface ConfidenceFactors {
  claimType: ClaimType;
  reliabilities: SourceReliability[];
  matchTypes: MatchType[];
  providerCount: number;
  verificationStatus: VerificationStatus;
  isSimulated: boolean;
}

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  score: number;
  rationale: string[];
}

const RELIABILITY_POINTS: Record<SourceReliability, number> = { authoritative: 3, reputable: 2, unknown: 1, low: 0 };
const MATCH_POINTS: Record<MatchType, number> = { exact: 1, normalized: 1, partial: 0, fuzzy: -1, none: -2 };
const ORDER: ConfidenceLevel[] = ['unverified', 'low', 'moderate', 'high', 'verified'];

const cap = (level: ConfidenceLevel, max: ConfidenceLevel): ConfidenceLevel => (ORDER.indexOf(level) > ORDER.indexOf(max) ? max : level);

export function assessConfidence(f: ConfidenceFactors): ConfidenceAssessment {
  const rationale: string[] = [];
  const bestReliability = f.reliabilities.reduce<SourceReliability>((best, r) => (RELIABILITY_POINTS[r] > RELIABILITY_POINTS[best] ? r : best), 'low');
  let score = RELIABILITY_POINTS[bestReliability];
  rationale.push(`Best source reliability: ${bestReliability} (+${RELIABILITY_POINTS[bestReliability]}).`);
  const bestMatch = f.matchTypes.reduce<MatchType>((best, m) => (MATCH_POINTS[m] > MATCH_POINTS[best] ? m : best), 'none');
  score += MATCH_POINTS[bestMatch];
  rationale.push(`Identifier match: ${bestMatch} (${MATCH_POINTS[bestMatch] >= 0 ? '+' : ''}${MATCH_POINTS[bestMatch]}).`);
  const corroboration = Math.min(2, Math.max(0, f.providerCount - 1));
  if (corroboration) {
    score += corroboration;
    rationale.push(`Corroborated by ${f.providerCount} providers (+${corroboration}).`);
  } else {
    rationale.push('Single provider (no corroboration).');
  }
  if (f.claimType === 'FACT') {
    score += 1;
    rationale.push('Direct observation of a technical fact (+1).');
  } else if (f.claimType === 'INFERENCE') {
    score -= 1;
    rationale.push('Inference rather than direct observation (-1).');
  }
  let level: ConfidenceLevel = score >= 5 ? 'high' : score >= 3 ? 'moderate' : score >= 1 ? 'low' : 'unverified';
  if (f.claimType === 'UNVERIFIED_LEAD' && f.providerCount < 2) {
    level = cap(level, 'low');
    rationale.push('Unverified lead from a single provider: capped at low.');
  }
  if (f.isSimulated) {
    rationale.push('SIMULATED demo data: the level illustrates the scoring method only and is not intelligence.');
  }
  switch (f.verificationStatus) {
    case 'verified':
      level = 'verified';
      rationale.push('Analyst verified the claim against adequate evidence.');
      break;
    case 'disputed':
      level = cap(level, 'low');
      rationale.push('Disputed by an analyst: capped at low.');
      break;
    case 'false_positive':
      level = 'unverified';
      rationale.push('Marked false positive by an analyst.');
      break;
    default:
      break;
  }
  return { level, score, rationale };
}
