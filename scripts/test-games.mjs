import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-game-tests-'));
const testFiles = [
  path.join(root, 'games/shared/GameStateMachine.test.ts'),
  path.join(root, 'src/game-platform/RealtimeBettingArchitecture.test.ts'),
  path.join(root, 'games/crash/CrashPolicy.test.ts'),
  path.join(root, 'src/game-platform/CrashSocketService.test.ts'),
  path.join(root, 'src/api/liveAnnouncements.test.ts'),
  path.join(root, 'src/api/exploreRankings.test.ts'),
  path.join(root, 'src/hooks/globalPermissionPolicy.test.ts'),
  path.join(root, 'src/rewards/rewardPolicy.test.ts'),
  path.join(root, 'src/agency/agencyLeavePolicy.test.ts'),
  path.join(root, 'src/api/deviceAccessPolicy.test.ts'),
  path.join(root, 'src/hooks/introPlaybackPolicy.test.ts'),
  path.join(root, 'src/hooks/mobileIntegrationPolicy.test.ts'),
  path.join(root, 'src/live/audioRoomSync.test.ts'),
  path.join(root, 'src/live/liveRoomPrivacy.test.ts'),
];
const supabaseTestStub = path.join(root, 'src/game-platform/TestSupabaseStub.test.ts');

try {
  await build({
    entryPoints: testFiles,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    outdir: temporaryDirectory,
    entryNames: '[name]',
    plugins: [{
      name: 'test-supabase-stub',
      setup(build) {
        build.onResolve({ filter: /(?:\.\.\/api\/supabase|src\/api\/supabase|\.\/supabase)$/ }, () => ({ path: supabaseTestStub }));
      },
    }],
  });
  const outputs = (await fs.readdir(temporaryDirectory))
    .filter((file) => file.endsWith('.test.js'))
    .map((file) => path.join(temporaryDirectory, file));
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...outputs], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
