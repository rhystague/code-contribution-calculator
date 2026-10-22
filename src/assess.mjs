import { collectEvidence } from './evidence.mjs';
import { score } from './scoring.mjs';
import { VERSION, hash, serialise } from './util.mjs';
import { configHash } from './config.mjs';

export function assess(path, repository, config) {
  try {
    const { evidence, observations, runtime } = collectEvidence(path, repository, config);
    const scores = score(evidence.identities, evidence.periods.length, config.weights, evidence.fatal);
    const status = scores.reasons.length ? 'unscorable' : evidence.warnings.length ? 'flagged' : 'scored';
    const canonical = { ...evidence, scores, status };
    return { canonical, evidenceHash: hash(serialise(canonical)), observations, runtime };
  } catch (error) {
    const canonical = { version: VERSION, repository, submitted: config.repositories[repository]?.submitted ?? null,
      baseline: config.repositories[repository]?.baseline ?? null, config, configHash: configHash(config),
      status: 'unscorable', warnings: [{ code: 'ANALYSIS_ERROR', message: error.message }],
      scores: { rows: [], reasons: [error.message] } };
    return { canonical, evidenceHash: hash(serialise(canonical)), observations: {}, runtime: { node: process.version } };
  }
}
