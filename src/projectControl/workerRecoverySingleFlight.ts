export interface WorkerRecoverySingleFlightKey {
  projectId: string;
  projectPath: string;
  runId: string;
}

export interface WorkerRecoverySingleFlightLease {
  release: () => void;
}

export interface WorkerRecoverySingleFlight {
  acquire: (key: WorkerRecoverySingleFlightKey) => WorkerRecoverySingleFlightLease | null;
}

function keyOf(key: WorkerRecoverySingleFlightKey): string {
  return JSON.stringify([key.projectId, key.projectPath, key.runId]);
}

/** Process-local admission guard for interactive recovery decisions. */
export function createWorkerRecoverySingleFlight(): WorkerRecoverySingleFlight {
  const active = new Map<string, symbol>();
  return {
    acquire: (key) => {
      const keyValue = keyOf(key);
      if (active.has(keyValue)) return null;
      const token = Symbol(keyValue);
      active.set(keyValue, token);
      return {
        release: () => {
          if (active.get(keyValue) === token) active.delete(keyValue);
        },
      };
    },
  };
}
