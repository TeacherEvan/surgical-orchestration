import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BuildPlan, FolderJob, SubagentResult, TestResult } from './types.js';
import { isInsideFolder } from './compactor.js';

export function buildJobMap(plan: BuildPlan): Map<string, FolderJob> {
  const folders = new Set<string>();
  for (const change of plan.changes) {
    const parent = path.dirname(change.filePath);
    const parts = parent.split(path.sep);
    if (parts.length >= 2) {
      folders.add(parts.slice(0, 2).join(path.sep));
    } else if (parts.length === 1 && parts[0]) {
      folders.add(parts[0]);
    }
  }
  const jobs = new Map<string, FolderJob>();
  Array.from(folders).forEach((folder, index) => {
    const id = `JOB-${String(index + 1).padStart(3, '0')}`;
    jobs.set(id, { id, parentFolder: folder, status: 'PENDING', attempts: 0, debriefHistory: [] });
  });
  return jobs;
}

export function buildWorkerInstructions(job: FolderJob, plan: BuildPlan): string {
  const relevantChanges = plan.changes.filter((c) =>
    isInsideFolder(path.dirname(c.filePath), job.parentFolder),
  );
  const feedback = job.lastVerifierFeedback
    ? `\nFeedback from attempt ${job.attempts} (address first):\n${job.lastVerifierFeedback}\n`
    : '';

  return `## Worker Mission: ${job.id}

Scope: ${job.parentFolder}

Changes required:
${relevantChanges.map((c) => `- ${c.filePath}: ${c.description}`).join('\n')}
${feedback}
Quality gates:
- Edit only inside ${job.parentFolder}; handle edge cases and errors explicitly
- Verify touched files with targeted lint/typecheck/tests before exiting

Exit protocol: Emit JSON with status, files_modified, debrief, self_audit.`;
}

export function buildVerifierInstructions(job: FolderJob, workerResult: SubagentResult): string {
  const modified = workerResult.filesModified.length
    ? workerResult.filesModified.join(', ')
    : '(none reported)';
  return `## Verifier Mission: ${job.id}

Review the Worker's changes in scope: ${job.parentFolder}
Worker debrief: ${workerResult.debrief}
Reported files: ${modified}

Check:
1. All required changes are complete and accurate
2. Zero scope boundary violations outside ${job.parentFolder}
3. Error paths, types, and tests pass cleanly

Exit protocol: Emit JSON with status (COMPLETED|FAILED), files_modified, debrief, self_audit.`;
}

export function findProjectRoot(plan: BuildPlan): string {
  const startDir = plan.changes[0]?.filePath
    ? path.dirname(plan.changes[0].filePath)
    : process.cwd();
  let root = path.resolve(startDir);
  while (root !== path.parse(root).root && !fs.existsSync(path.join(root, 'package.json'))) {
    root = path.dirname(root);
  }
  return fs.existsSync(path.join(root, 'package.json')) ? root : process.cwd();
}

export function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function readArchitectureDiagram(projectRoot: string): string | null {
  for (const candidate of [
    'ARCHITECTURE.md',
    'docs/architecture.md',
    'docs/ARCHITECTURE.md',
    'architecture.md',
  ]) {
    const content = readIfExists(path.join(projectRoot, candidate));
    if (content) return content;
  }
  return null;
}

export function buildTestFixerContext(projectRoot: string, testResult: TestResult, ledgerJson: string): string {
  const readme = readIfExists(path.join(projectRoot, 'README.md'));
  const archDiagram = readArchitectureDiagram(projectRoot);
  return [
    'TEST FAILURE CONTEXT:',
    `Trace: ${testResult.trace?.substring(0, 8000) ?? ''}`,
    `Failing Specs: ${testResult.failingSpecs?.join(', ') ?? ''}`,
    '',
    'PROJECT CONTEXT:',
    `README: ${readme?.substring(0, 4000) ?? ''}`,
    `ARCHITECTURE: ${archDiagram?.substring(0, 4000) ?? ''}`,
    '',
    'COMPACTED LEDGER:',
    ledgerJson,
  ].join('\n');
}

export function extractFailingSpecs(output: string): string[] {
  const specs = new Set<string>();
  const patterns = [/([\w/.-]+\.spec\.(ts|js)):?\d*/g, /([\w/.-]+\.test\.(ts|js)):?\d*/g];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return Array.from(specs);
}

export function executePlaywrightCommand(projectRoot: string): TestResult {
  try {
    execSync('npx playwright test', {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 120_000,
      encoding: 'utf-8',
    });
    return { passed: true };
  } catch (error: unknown) {
    const errObj = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const failureLog =
      errObj.stdout?.toString() || errObj.stderr?.toString() || errObj.message || 'Playwright failed';
    return {
      passed: false,
      trace: failureLog,
      failureLog,
      failingSpecs: extractFailingSpecs(failureLog),
    };
  }
}
