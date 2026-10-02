import { mkdir, open, link, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MemoryRunError } from "../errors.js";
import { checkRunId, parseMemoryRun, serializeRunValue } from "../runs.js";
import type { MemoryRun, MemoryRunStore } from "../runs.js";
import { checkFields, parseJson } from "../validation.js";

async function digest(value: unknown): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializeRunValue(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Local append-only terminal records. The containing directory is trusted host storage. */
export class FileMemoryRunStore implements MemoryRunStore {
  readonly directory: string;

  constructor(directory: string) { this.directory = resolve(directory); }

  async save(value: MemoryRun): Promise<void> {
    const run = parseMemoryRun(value);
    const file = join(this.directory, `${run.id}.json`);
    const temporary = join(this.directory, `.${run.id}.${globalThis.crypto.randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ formatVersion: 1, hash: await digest(run), run }) + "\n", "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      // Publishing by hard link is atomic and fails if the Run ID already exists.
      await link(temporary, file);
    } catch (error) {
      throw new MemoryRunError(`Cannot save Run ${run.id}: ${error instanceof Error ? error.message : String(error)}`, "E_RUN_STORE");
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async get(id: string): Promise<MemoryRun | undefined> {
    checkRunId(id);
    let content: string;
    try { content = await readFile(join(this.directory, `${id}.json`), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new MemoryRunError(`Cannot read Run ${id}: ${error instanceof Error ? error.message : String(error)}`, "E_RUN_STORE");
    }
    try {
      const envelope = parseJson(content);
      checkFields(envelope, "Run envelope");
      if (Object.keys(envelope).sort().join(",") !== "formatVersion,hash,run" || envelope.formatVersion !== 1 || typeof envelope.hash !== "string") throw new Error("Invalid Run envelope.");
      const run = parseMemoryRun(envelope.run);
      if (run.id !== id || envelope.hash !== await digest(run)) throw new Error("Run ID or content hash mismatch.");
      return run;
    } catch (error) {
      throw new MemoryRunError(`Invalid stored Run ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
