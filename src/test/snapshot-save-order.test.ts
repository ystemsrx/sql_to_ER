import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { GraphLike } from "../types";

const captures = vi.hoisted(() => [] as Array<(error: unknown, result?: unknown) => void>);
vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useEffect: () => {} }));
vi.mock("@antv/g6", () => ({ default: {} }));
vi.mock("../exporter", () => ({
  buildExportSVG: (_: unknown, callback: (error: unknown, result?: unknown) => void) =>
    captures.push(callback),
  clampExportScale: () => 1,
}));

beforeEach(() => {
  vi.resetModules();
  captures.length = 0;
  const indexedDB = new IDBFactory();
  vi.stubGlobal("window", { indexedDB });
  vi.stubGlobal("indexedDB", indexedDB);
  vi.stubGlobal(
    "Image",
    class {
      onload = () => {};
      set src(_: string) {
        queueMicrotask(() => this.onload());
      }
    },
  );
  let thumbnail = 0;
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => `thumbnail-${++thumbnail}`,
    }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const meta = {
  id: "project",
  inputText: "CREATE TABLE own_schema(id INT);",
  isColored: true,
  showComment: false,
  hideFields: false,
};

it("rejects an older data write that resumes after a newer save", async () => {
  const snapshots = await import("../snapshots");
  const { useSnapshotPersistence } = await import("../hooks/useSnapshotPersistence");
  const upsert = snapshots.upsert;
  let resume: () => void = () => {};
  vi.spyOn(snapshots, "upsert").mockImplementationOnce(
    (id, merge) =>
      new Promise((resolve, reject) => {
        resume = () => {
          void upsert(id, merge).then(resolve, reject);
        };
      }),
  );
  let x = 1;
  const graphRef = {
    current: { getNodes: () => [{ getModel: () => ({ id: "n", x }) }] } as unknown as GraphLike,
  };
  const persistence = useSnapshotPersistence({ graphRef, containerRef: { current: null } });
  const older = persistence.persistSnapshot(meta, { skipThumbnail: true });
  x = 2;
  await persistence.persistSnapshot(meta, { skipThumbnail: true });
  resume();
  await older;
  expect((await snapshots.get(meta.id))?.nodes[0].x).toBe(2);
});

it("saves geometry before thumbnail completion and rejects stale thumbnail updates", async () => {
  const snapshots = await import("../snapshots");
  const { useSnapshotPersistence } = await import("../hooks/useSnapshotPersistence");
  let x = 1;
  const graphRef = {
    current: {
      getNodes: () => [{ getModel: () => ({ id: "n", x, y: 0, label: "n" }) }],
    } as unknown as GraphLike,
  };
  const persistence = useSnapshotPersistence({ graphRef, containerRef: { current: null } });
  await persistence.persistSnapshot(meta);
  expect((await snapshots.get(meta.id))?.nodes[0].x).toBe(1);
  x = 2;
  await persistence.persistSnapshot({ ...meta, fontScale: 1.2 });
  const newer = await snapshots.get(meta.id);
  expect(newer).toMatchObject({ nodes: [{ x: 2 }], fontScale: 1.2, thumbnail: null });
  captures[1](null, { svgString: "<svg/>", width: 10, height: 10 });
  await vi.waitFor(async () =>
    expect((await snapshots.get(meta.id))?.thumbnail).toBe("thumbnail-1"),
  );
  captures[0](null, { svgString: "<svg/>", width: 10, height: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await snapshots.get(meta.id)).toMatchObject({
    nodes: [{ x: 2 }],
    thumbnail: "thumbnail-1",
    revision: newer!.revision,
    updatedAt: newer!.updatedAt,
  });
});

it("keeps a page-hide flush newer than an in-flight rasterization", async () => {
  const snapshots = await import("../snapshots");
  const { useSnapshotPersistence } = await import("../hooks/useSnapshotPersistence");
  let x = 1;
  const graphRef = {
    current: { getNodes: () => [{ getModel: () => ({ id: "n", x }) }] } as unknown as GraphLike,
  };
  const persistence = useSnapshotPersistence({ graphRef, containerRef: { current: null } });
  await persistence.persistSnapshot(meta);
  x = 3;
  persistence.schedulePersist(meta, 10_000);
  persistence.flushPendingPersist();
  await vi.waitFor(async () => expect((await snapshots.get(meta.id))?.nodes[0].x).toBe(3));
  captures[0](null, { svgString: "<svg/>", width: 10, height: 10 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await snapshots.get(meta.id)).toMatchObject({ nodes: [{ x: 3 }], thumbnail: null });
});
