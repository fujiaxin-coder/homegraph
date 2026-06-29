import { Worker } from 'worker_threads';
import * as path from 'path';

const PHASE_NAMES: Record<string, string> = {
  scanning: 'Scanning files',
  parsing: 'Parsing code',
  'arkts-batch': 'Parsing ArkTS',
  storing: 'Storing data',
  resolving: 'Resolving refs',
};

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
  currentFile?: string;
  subphase?: 'scene' | 'persist';
}

function formatArkTSBatchMessage(progress: IndexProgress): string {
  const total = progress.total;
  if (progress.subphase === 'scene') {
    return total > 0 ? `Building ArkTS scene (${total} files)` : 'Building ArkTS scene';
  }
  const base =
    total > 0 ? `Storing ArkTS ${progress.current}/${total}` : 'Storing ArkTS';
  if (progress.currentFile) {
    return `${base} ${path.basename(progress.currentFile)}`;
  }
  return base;
}

export interface ShimmerProgress {
  onProgress: (progress: IndexProgress) => void;
  stop: () => Promise<void>;
}

export function createShimmerProgress(): ShimmerProgress {
  let lastPhase = '';

  const workerPath = path.join(__dirname, 'shimmer-worker.js');
  const worker = new Worker(workerPath, {
    workerData: { startTime: Date.now() },
  });

  return {
    onProgress(progress: IndexProgress) {
      const phaseName =
        progress.phase === 'arkts-batch'
          ? formatArkTSBatchMessage(progress)
          : PHASE_NAMES[progress.phase] || progress.phase;

      if (progress.phase !== lastPhase && lastPhase) {
        worker.postMessage({ type: 'finish-phase' });
      }
      lastPhase = progress.phase;

      let percent = -1;
      let count = 0;
      if (progress.phase === 'arkts-batch' && progress.subphase === 'scene') {
        percent = -1;
      } else if (progress.total > 0) {
        percent = Math.round((progress.current / progress.total) * 100);
      } else if (progress.current > 0) {
        count = progress.current;
      }

      worker.postMessage({
        type: 'update',
        phase: progress.phase,
        phaseName,
        percent,
        count,
      });
    },

    stop() {
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          worker.terminate().then(() => resolve());
        }, 2000);

        worker.on('message', (msg: { type: string }) => {
          if (msg.type === 'stopped') {
            clearTimeout(timeout);
            worker.terminate().then(() => resolve());
          }
        });

        worker.postMessage({ type: 'stop' });
      });
    },
  };
}
