import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBVersionChangeEvent, forceCloseDatabase } from "fake-indexeddb";

let factory: IDBFactory;
beforeEach(() => {
  vi.resetModules();
  factory = new IDBFactory();
  vi.stubGlobal("window", { indexedDB: factory });
  vi.stubGlobal("indexedDB", factory);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retries after an initial open failure without reloading the module", async () => {
  const open = vi.spyOn(factory, "open");
  open.mockImplementationOnce(() => {
    const req = {
      error: new DOMException("temporary failure", "UnknownError"),
    } as IDBOpenDBRequest;
    queueMicrotask(() => req.onerror!(new Event("error")));
    return req;
  });
  const snapshots = await import("../snapshots");
  await expect(snapshots.get("test")).rejects.toThrow("temporary failure");
  await expect(snapshots.get("test")).resolves.toBeNull();
  expect(open).toHaveBeenCalledTimes(2);
});

it.each(["close", "versionchange"])("reopens after connection %s", async (event) => {
  const open = vi.spyOn(factory, "open");
  const snapshots = await import("../snapshots");
  await snapshots.get("test");
  const db = open.mock.results[0].value.result as IDBDatabase;
  // fake-indexeddb 6.2.5 declares a constructor here; its runtime accepts an instance.
  if (event === "close")
    forceCloseDatabase(db as unknown as Parameters<typeof forceCloseDatabase>[0]);
  else
    db.dispatchEvent(new IDBVersionChangeEvent("versionchange", { oldVersion: 1, newVersion: 2 }));
  await expect(snapshots.get("test")).resolves.toBeNull();
  expect(open).toHaveBeenCalledTimes(2);
});

it("closes a late successful connection after a blocked open was abandoned", async () => {
  let req: IDBOpenDBRequest;
  const open = vi.spyOn(factory, "open").mockImplementationOnce(() => {
    req = {} as IDBOpenDBRequest;
    queueMicrotask(() => req.onblocked!(new Event("blocked") as IDBVersionChangeEvent));
    return req;
  });
  const snapshots = await import("../snapshots");
  await expect(snapshots.get("test")).rejects.toThrow("blocked");
  const close = vi.fn();
  Object.assign(req!, { result: { close } });
  req!.onsuccess!(new Event("success"));
  expect(close).toHaveBeenCalledOnce();
  await expect(snapshots.get("test")).resolves.toBeNull();
  expect(open).toHaveBeenCalledTimes(2);
});
