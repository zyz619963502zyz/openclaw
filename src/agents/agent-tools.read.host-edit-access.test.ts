/**
 * Tests host edit access behavior for workspace escapes.
 * Ensures OpenClaw lets the real guarded read path report escape errors
 * instead of upstream access checks masking them as missing files.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createSandboxedWriteTool,
} from "./agent-tools.read.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

type CapturedEditOperations = {
  access: (absolutePath: string) => Promise<void>;
};

type CapturedWriteOperations = {
  readFile?: (absolutePath: string) => Promise<Buffer | string>;
  statFile?: (absolutePath: string) => Promise<unknown>;
};

const mocks = vi.hoisted(() => ({
  operations: undefined as CapturedEditOperations | undefined,
  writeOperations: undefined as CapturedWriteOperations | undefined,
}));

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: { operations?: CapturedEditOperations }) => {
      mocks.operations = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      };
    },
    createWriteTool: (_cwd: string, options?: { operations?: CapturedWriteOperations }) => {
      mocks.writeOperations = options?.operations;
      return {
        name: "write",
        description: "test write tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      };
    },
  };
});

describe("createHostWorkspaceEditTool host access mapping", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.operations = undefined;
    mocks.writeOperations = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")(
    "silently passes access for outside-workspace paths so readFile reports the real error",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-access-test-"));
      const workspaceDir = path.join(tmpDir, "workspace");
      const outsideDir = path.join(tmpDir, "outside");
      const linkDir = path.join(workspaceDir, "escape");
      const outsideFile = path.join(outsideDir, "secret.txt");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "secret", "utf8");
      await fs.symlink(outsideDir, linkDir);

      createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
      if (mocks.operations === undefined) {
        throw new Error("expected host edit operations mock");
      }

      // access must NOT throw for outside-workspace paths; the upstream
      // library replaces any access error with a misleading "File not found".
      // By resolving silently the subsequent readFile call surfaces the real
      // "Path escapes workspace root" / "outside-workspace" error instead.
      const operations = mocks.operations;
      if (!operations) {
        throw new Error("Expected workspace edit operations to be registered.");
      }
      await expect(
        operations.access(path.join(workspaceDir, "escape", "secret.txt")),
      ).resolves.toBeUndefined();
    },
  );

  it("provides readback and stat operations to host writes", () => {
    createHostWorkspaceWriteTool("/workspace", { workspaceOnly: false });

    expect(mocks.writeOperations?.readFile).toBeTypeOf("function");
    expect(mocks.writeOperations?.statFile).toBeTypeOf("function");
  });

  it("provides readback and stat operations to sandbox writes", () => {
    createSandboxedWriteTool({
      root: "/workspace",
      bridge: {} as SandboxFsBridge,
    });

    expect(mocks.writeOperations?.readFile).toBeTypeOf("function");
    expect(mocks.writeOperations?.statFile).toBeTypeOf("function");
  });
});
