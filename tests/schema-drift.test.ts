/**
 * Draft 2020-12 Schema <-> Emitter Drift Guard.
 *
 * Validates serialized runtime payloads (JobCard via serializeJobCard(),
 * DebriefPayload, SubagentExitPayload, BuildPlan) against the JSON Schema
 * 2020-12 contracts in references/*-schema.json.
 */
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDebriefHash, type DebriefPayload } from '../references/debrief.js';
import {
  OrchestrationEngine,
  serializeJobCard,
  type AgentRole,
  type BuildPlan,
  type SubagentDispatcher,
  type SubagentResult,
} from '../references/orchestrator.js';
import { dryRunDispatcher, parseSubagentResult } from '../references/surgical-orchestration.js';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REFS_DIR = join(ROOT_DIR, 'references');

const loadJson = (relPath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REFS_DIR, relPath), 'utf8')) as Record<string, unknown>;

const jobcardSchema = loadJson('jobcard-schema.json');
const exitSchema = loadJson('subagent-exit-schema.json');
const debriefSchema = loadJson('debrief-schema.json');
const buildPlanSchema = loadJson('build-plan-schema.json');
const sampleBuildPlan = loadJson('build-plan.json');

function check(schema: Record<string, unknown>, data: unknown): string[] {
  const out: string[] = [];
  walk(schema, data, schema, '', out);
  return out;
}

function resolveRef(ref: string, root: Record<string, unknown>): Record<string, unknown> {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<Record<string, unknown>>((acc, key) => acc[key] as Record<string, unknown>, root);
}

function walk(
  schema: Record<string, unknown>,
  data: unknown,
  root: Record<string, unknown>,
  path: string,
  out: string[],
): void {
  let s = schema;
  if (typeof s.$ref === 'string') {
    const target = resolveRef(s.$ref, root);
    const rest = { ...s };
    delete (rest as { $ref?: string }).$ref;
    s = { ...target, ...rest };
  }

  const t = s.type as string | undefined;
  if (t === 'object') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      out.push(`${path}: expected object`);
      return;
    }
    const obj = data as Record<string, unknown>;
    for (const r of (s.required as string[] | undefined) ?? []) {
      if (!(r in obj)) out.push(`${path}: missing required ${r}`);
    }
    const props = (s.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const closed = s.unevaluatedProperties === false || s.additionalProperties === false;

    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      const sub = s.additionalProperties as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (!(k in props)) walk(sub, obj[k], root, `${path}.${k}`, out);
      }
    } else if (closed) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) out.push(`${path}: unevaluated/additional prop not allowed: ${k}`);
      }
    }

    for (const k of Object.keys(props)) {
      if (k in obj) walk(props[k], obj[k], root, `${path}.${k}`, out);
    }
    return;
  }

  if (t === 'array') {
    if (!Array.isArray(data)) {
      out.push(`${path}: expected array`);
      return;
    }
    if (typeof s.minItems === 'number' && data.length < s.minItems) {
      out.push(`${path}: length ${data.length} < minItems ${s.minItems}`);
    }
    if (s.uniqueItems === true) {
      const seen = new Set(data.map((item) => JSON.stringify(item)));
      if (seen.size !== data.length) {
        out.push(`${path}: duplicate items violate uniqueItems`);
      }
    }
    if (s.items) {
      for (let i = 0; i < data.length; i++) {
        walk(s.items as Record<string, unknown>, data[i], root, `${path}[${i}]`, out);
      }
    }
    return;
  }

  if (t === 'string') {
    if (typeof data !== 'string') {
      out.push(`${path}: expected string`);
      return;
    }
    if (typeof s.minLength === 'number' && data.length < s.minLength) {
      out.push(`${path}: length < minLength ${s.minLength}`);
    }
    if (Array.isArray(s.enum) && !s.enum.includes(data)) {
      out.push(`${path}: enum violation ${JSON.stringify(data)}`);
    }
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(data)) {
      out.push(`${path}: pattern fail`);
    }
    return;
  }

  if (t === 'integer' || t === 'number') {
    if (typeof data !== 'number' || Number.isNaN(data)) {
      out.push(`${path}: expected number`);
      return;
    }
    if (t === 'integer' && !Number.isInteger(data)) {
      out.push(`${path}: expected integer, got ${data}`);
    }
    if (typeof s.minimum === 'number' && data < s.minimum) out.push(`${path}: < min`);
    if (typeof s.maximum === 'number' && data > s.maximum) out.push(`${path}: > max`);
  }
}

async function main(): Promise<void> {
  // 0. All 4 schemas declare Draft 2020-12 + unevaluatedProperties: false
  for (const [name, schema] of [
    ['jobcard-schema.json', jobcardSchema],
    ['debrief-schema.json', debriefSchema],
    ['subagent-exit-schema.json', exitSchema],
    ['build-plan-schema.json', buildPlanSchema],
  ] as const) {
    assert.equal(
      schema.$schema,
      'https://json-schema.org/draft/2020-12/schema',
      `${name} must target Draft 2020-12`,
    );
    assert.equal(schema.unevaluatedProperties, false, `${name} must set unevaluatedProperties: false`);
  }

  // 1. Prompt-shaped exit payload & up-chain recommendations/suggestions
  const promptPayload = {
    status: 'COMPLETED',
    files_modified: ['src/a.ts'],
    debrief: 'Implemented scoped change.',
    self_audit: 'tsc and unit tests passed.',
  };
  assert.deepEqual(check(exitSchema, promptPayload), [], 'prompt payload validates');
  assert.deepEqual(
    check(exitSchema, {
      ...promptPayload,
      recommendations: ['Add edge-case test'],
      suggestions: ['Extract helper'],
    }),
    [],
    'up-chain recommendations/suggestions validate',
  );
  assert.ok(
    check(exitSchema, { ...promptPayload, extraField: true }).length > 0,
    'unevaluatedProperties rejects extra field on SubagentExitPayload',
  );

  // 2. parseSubagentResult + dryRunDispatcher wire compatibility
  const parsed = parseSubagentResult(
    '```json\n{"status":"COMPLETED","files_modified":["a.ts"],"debrief":"ok","self_audit":"clean","recommendations":["R1"],"suggestions":["S1"]}\n```',
  );
  assert.deepEqual(parsed.recommendations, ['R1']);
  assert.deepEqual(parsed.suggestions, ['S1']);

  const dryReview = await dryRunDispatcher('reviewer-fe', {
    missionId: 'REVIEW-FRONTEND_REVIEWER',
    role: 'FRONTEND_REVIEWER',
    allowedFolderScope: '.',
    instructions: 'review',
    contextSummary: 'ctx',
  });
  assert.equal(dryReview.recommendations?.length, 2, 'dryRunDispatcher emits 2 reviewer recs');
  assert.equal(dryReview.suggestions?.length, 2, 'dryRunDispatcher emits 2 reviewer suggestions');

  // 3. JobCard schema: all 7 AgentRoles, serializeJobCard() round-trip, negative guards
  const roles: AgentRole[] = [
    'WORKER',
    'VERIFIER',
    'TEST_FIXER',
    'CODE_REVIEWER',
    'FRONTEND_REVIEWER',
    'BACKEND_REVIEWER',
    'COMPOSER',
  ];
  const validJobCard = {
    planId: 'BUILD-1',
    overallStatus: 'IN_PROGRESS',
    jobs: {
      'JOB-001': {
        id: 'JOB-001',
        parentFolder: 'src/a',
        status: 'VERIFIED',
        attempts: 2,
        debriefHistory: roles.map((agentRole, i) => ({
          attempt: i + 1,
          agentRole,
          debrief: 'ok',
          hash: 'a'.repeat(64),
        })),
      },
    },
    completedHashes: ['a'.repeat(64)],
  };
  assert.deepEqual(check(jobcardSchema, validJobCard), [], 'all 7 AgentRoles validate');

  const overCap = JSON.parse(JSON.stringify(validJobCard)) as typeof validJobCard;
  overCap.jobs['JOB-001'].attempts = 4;
  assert.ok(check(jobcardSchema, overCap).length > 0, 'attempts > 3 rejected');

  const floatAttempts = JSON.parse(JSON.stringify(validJobCard)) as typeof validJobCard;
  floatAttempts.jobs['JOB-001'].attempts = 1.5;
  assert.ok(check(jobcardSchema, floatAttempts).length > 0, 'non-integer attempts rejected');

  const dupHashes = JSON.parse(JSON.stringify(validJobCard)) as typeof validJobCard;
  dupHashes.completedHashes = ['a'.repeat(64), 'a'.repeat(64)];
  assert.ok(check(jobcardSchema, dupHashes).length > 0, 'duplicate hashes rejected');

  // Live OrchestrationEngine -> serializeJobCard() -> jobcardSchema
  const livePlan = sampleBuildPlan as unknown as BuildPlan;
  const liveDispatch: SubagentDispatcher = async (_id, payload) => {
    const res: SubagentResult = {
      status: 'COMPLETED',
      filesModified: [],
      debrief: `done ${payload.missionId}`,
      selfAudit: 'verified',
    };
    return res;
  };
  const engine = new OrchestrationEngine(livePlan, liveDispatch, { skipTests: true });
  const runResult = await engine.run();
  const serialized = serializeJobCard(runResult.jobCard);
  assert.deepEqual(
    check(jobcardSchema, serialized),
    [],
    'live serialized JobCard validates against jobcard-schema.json',
  );

  // 4. DebriefPayload schema
  const okDebrief: DebriefPayload = {
    directory: 'src/a',
    modifiedFiles: ['b.ts', 'a.ts'],
    diffHash: 'x',
  };
  assert.equal(computeDebriefHash(okDebrief).length, 64);
  assert.deepEqual(check(debriefSchema, okDebrief), [], 'DebriefPayload validates');
  assert.ok(
    check(debriefSchema, { ...okDebrief, unknown: 1 }).length > 0,
    'unevaluatedProperties rejects extra DebriefPayload key',
  );

  // 5. BuildPlan schema
  assert.deepEqual(check(buildPlanSchema, sampleBuildPlan), [], 'references/build-plan.json validates');
  assert.ok(
    check(buildPlanSchema, { description: 'empty', changes: [] }).length > 0,
    'empty changes array rejected by build-plan-schema.json',
  );

  console.log('ALL SCHEMA DRIFT ASSERTIONS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
