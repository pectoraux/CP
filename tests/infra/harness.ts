// tests/infra/harness.ts
// Real-infrastructure test harness for WORK-002. Spawns REAL PostgreSQL 17,
// Redis 8, and Minio (S3-compatible) on random local ports — no Docker, no
// root, no mocks. Binaries are provisioned reproducibly by
// scripts/bootstrap-infra.sh into .infra/ (gitignored). Each withInfra()
// call gets its own run directory and per-process procs/cleanups, so
// parallel test files never collide on shared state.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import IORedis from "ioredis";
import { S3CompatibleObjectStorage } from "@cp/platform";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "..", "..");
const INFRA = join(ROOT, ".infra");

export interface InfraHandle {
  pg: { connectionString: string; port: number };
  redis: { url: string; port: number };
  storage: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    port: number;
  };
  stop(): Promise<void>;
}

function randPort(base: number): number {
  return base + Math.floor(Math.random() * 1000);
}

let bootstrapped = false;
async function ensureBootstrapped(): Promise<void> {
  if (bootstrapped) return;
  const redis = join(INFRA, "redis-root/usr/bin/redis-server");
  const pgBin = join(INFRA, "pg-root/usr/lib/postgresql/17/bin/postgres");
  const minio = join(INFRA, "minio/minio");
  if (!(existsSync(redis) && existsSync(pgBin) && existsSync(minio))) {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/bootstrap-infra.sh"],
      cwd: ROOT,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`bootstrap-infra.sh exited ${code}`);
  }
  bootstrapped = true;
}

interface Proc {
  name: string;
  stop: () => Promise<void>;
}

class InfraStack {
  readonly run: string;
  private readonly procs: Proc[] = [];
  private readonly dirCleanups: Array<() => Promise<void>> = [];

  constructor() {
    this.run = join(INFRA, "run", `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  private spawnServer(name: string, cmd: string[], env: Record<string, string>): Proc {
    const logPath = join(this.run, `${name}.log`);
    const log = Bun.file(logPath);
    const proc = Bun.spawn({
      cmd,
      env,
      cwd: ROOT,
      stdin: "ignore",
      stdout: log,
      stderr: log,
    });
    return {
      name,
      stop: async () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        try {
          await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 800))]);
        } catch {
          // ignore
        }
      },
    };
  }

  private async runOnce(cmd: string, args: string[], env: Record<string, string>, label: string): Promise<void> {
    const logPath = join(this.run, `${label}.log`);
    const proc = Bun.spawn({
      cmd: [cmd, ...args],
      env,
      cwd: ROOT,
      stdin: "ignore",
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
    });
    const code = await proc.exited;
    if (code !== 0) {
      let tail = "";
      try {
        tail = await Bun.file(logPath).text();
      } catch {
        // ignore
      }
      throw new Error(`${label} exited ${code}\n${tail.slice(-1200)}`);
    }
  }

  private async waitReady(label: string, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        if (await fn()) return;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${label} did not become ready within ${timeoutMs}ms (last: ${lastErr})`);
  }

  async startRedis(port: number): Promise<void> {
    const bin = join(INFRA, "redis-root/usr/bin/redis-server");
    const libDir = join(INFRA, "redis-root/usr/lib/x86_64-linux-gnu");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      LD_LIBRARY_PATH: `${libDir}:${process.env.LD_LIBRARY_PATH ?? ""}`,
    };
    this.procs.push(this.spawnServer("redis", [bin, "--port", String(port), "--save", "", "--appendonly", "no", "--daemonize", "no"], env));
    await this.waitReady("redis", async () => {
      const c = new IORedis(`redis://127.0.0.1:${port}`, {
        connectTimeout: 1000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      // Silence ioredis 'error' events emitted while redis is still starting
      // (the ping rejection below is the actual readiness signal).
      c.on("error", () => {});
      try {
        return (await c.ping()) === "PONG";
      } catch {
        return false;
      } finally {
        c.disconnect(false);
      }
    });
  }

  async startMinio(port: number, creds: { accessKey: string; secretKey: string }): Promise<string> {
    const bin = join(INFRA, "minio/minio");
    const dataDir = join(this.run, "minio-data");
    await mkdir(dataDir, { recursive: true });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MINIO_ROOT_USER: creds.accessKey,
      MINIO_ROOT_PASSWORD: creds.secretKey,
    };
    this.procs.push(this.spawnServer("minio", [bin, "server", dataDir, "--address", `127.0.0.1:${port}`, "--console-address", `127.0.0.1:${port + 1}`], env));
    await this.waitReady("minio", async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/minio/health/live`);
        return r.ok;
      } catch {
        return false;
      }
    });
    return `http://127.0.0.1:${port}`;
  }

  async startPostgres(port: number): Promise<void> {
    const binDir = join(INFRA, "pg-root/usr/lib/postgresql/17/bin");
    const libDir = join(INFRA, "pg-root/usr/lib/x86_64-linux-gnu");
    const dataDir = join(this.run, "pgdata");
    await mkdir(dataDir, { recursive: true });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      LD_LIBRARY_PATH: `${libDir}:${process.env.LD_LIBRARY_PATH ?? ""}`,
    };
    await this.runOnce(`${binDir}/initdb`, ["-D", dataDir, "-U", "postgres", "--no-locale", "-E", "UTF8", "--auth-local", "trust", "--auth-host", "trust"], env, "initdb");
    await writeFile(
      join(dataDir, "postgresql.conf"),
      `\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${this.run}'\n`,
      { flag: "a" },
    );
    await this.runOnce(`${binDir}/pg_ctl`, ["-D", dataDir, "-l", join(this.run, "pg.log"), "-w", "start"], env, "pg_ctl-start");
    this.procs.push({
      name: "postgres",
      stop: async () => {
        await this.runOnce(`${binDir}/pg_ctl`, ["-D", dataDir, "-m", "fast", "-w", "stop"], env, "pg_ctl-stop");
      },
    });
    this.dirCleanups.push(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });
    await this.waitReady("postgres", async () => {
      const pool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres` });
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      } finally {
        await pool.end();
      }
    });
  }

  async teardown(): Promise<void> {
    for (const p of this.procs) {
      try {
        await p.stop();
      } catch {
        // ignore
      }
    }
    this.procs.length = 0;
    for (const c of this.dirCleanups) {
      try {
        await c();
      } catch {
        // ignore
      }
    }
    this.dirCleanups.length = 0;
    try {
      await rm(this.run, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Run `fn` against a fresh real PostgreSQL + Redis + Minio. `stop()` is
 * called automatically at the end (even on failure), so no services leak.
 */
export async function withInfra<T>(
  fn: (h: InfraHandle) => Promise<T>,
): Promise<T> {
  await ensureBootstrapped();
  const stack = new InfraStack();
  await mkdir(stack.run, { recursive: true });

  const pgPort = randPort(44000);
  const redisPort = randPort(45000);
  const minioPort = randPort(46000);
  const accessKey = "cp_test_key";
  const secretKey = "cp_test_secret_0123456789abcdef";
  const bucket = "cp-test";

  try {
    await stack.startPostgres(pgPort);
    await stack.startRedis(redisPort);
    const endpoint = await stack.startMinio(minioPort, { accessKey, secretKey });

    const bootstrapStorage = new S3CompatibleObjectStorage({
      endpoint,
      region: "us-east-1",
      bucket,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      forcePathStyle: true,
    });
    await bootstrapStorage.ensureBucket();

    const handle: InfraHandle = {
      pg: {
        connectionString: `postgres://postgres@127.0.0.1:${pgPort}/postgres`,
        port: pgPort,
      },
      redis: { url: `redis://127.0.0.1:${redisPort}`, port: redisPort },
      storage: { endpoint, bucket, accessKeyId: accessKey, secretAccessKey: secretKey, region: "us-east-1", port: minioPort },
      stop: () => stack.teardown(),
    };
    return await fn(handle);
  } finally {
    await stack.teardown();
  }
}
