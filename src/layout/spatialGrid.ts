/**
 * Spatial hashing helpers shared by the layout / avoidance modules.
 *
 * Two flavours are provided:
 *
 * - `buildGrid` / `forEachNeighbor`: the light-weight point grid that
 *   arrangeLayout has always used for its pairwise separation loops.
 * - `SpatialGrid`: a rectangle/segment-aware grid used by the avoidance code
 *   to answer "which items are near this box / segment" without scanning all
 *   nodes and edges.
 */

export interface GridPositioned {
  pos: { x: number; y: number };
}

/** Bucket point-like items into square cells keyed by "cx,cy". */
export const buildGrid = <T extends GridPositioned>(
  items: T[],
  cellSize: number,
): Map<string, T[]> => {
  const grid = new Map<string, T[]>();
  items.forEach((item) => {
    const cx = Math.floor(item.pos.x / cellSize);
    const cy = Math.floor(item.pos.y / cellSize);
    const key = cx + "," + cy;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(item);
  });
  return grid;
};

/** Visit every item in the 3x3 cell neighbourhood around `item`. */
export const forEachNeighbor = <T extends GridPositioned>(
  grid: Map<string, T[]>,
  cellSize: number,
  item: GridPositioned,
  cb: (other: T) => void,
): void => {
  const cx = Math.floor(item.pos.x / cellSize);
  const cy = Math.floor(item.pos.y / cellSize);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const bucket = grid.get(cx + ox + "," + (cy + oy));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) cb(bucket[k]);
    }
  }
};

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A mutable rectangle-aware spatial hash. Items are inserted with an AABB and
 * can be moved or removed; queries visit each stored item at most once.
 */
export class SpatialGrid<T> {
  private cells = new Map<string, Set<T>>();
  private bounds = new Map<T, Bounds>();
  private overflow = new Set<T>();

  constructor(private cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) this.cellSize = 64;
  }

  private forEachCellKey(bounds: Bounds, cb: (key: string) => void): boolean {
    const size = this.cellSize;
    const minCx = Math.floor(bounds.minX / size);
    const maxCx = Math.floor(bounds.maxX / size);
    const minCy = Math.floor(bounds.minY / size);
    const maxCy = Math.floor(bounds.maxY / size);
    const width = maxCx - minCx + 1;
    const height = maxCy - minCy + 1;
    // Wide segments and unsafe coordinates use an item scan. Never allocate or
    // iterate an unbounded rectangle of cells, even for finite JS numbers.
    if (
      ![minCx, maxCx, minCy, maxCy].every(Number.isSafeInteger) ||
      width <= 0 ||
      height <= 0 ||
      width * height > 4096
    )
      return false;
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        cb(cx + "," + cy);
      }
    }
    return true;
  }

  insert(item: T, bounds: Bounds): void {
    this.remove(item);
    this.bounds.set(item, bounds);
    const indexed = this.forEachCellKey(bounds, (key) => {
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = new Set();
        this.cells.set(key, bucket);
      }
      bucket.add(item);
    });
    if (!indexed) this.overflow.add(item);
  }

  remove(item: T): void {
    const bounds = this.bounds.get(item);
    if (!bounds) return;
    this.forEachCellKey(bounds, (key) => {
      const bucket = this.cells.get(key);
      if (!bucket) return;
      bucket.delete(item);
      if (!bucket.size) this.cells.delete(key);
    });
    this.bounds.delete(item);
    this.overflow.delete(item);
  }

  /** Visit every item whose cells intersect the query rectangle (padded). */
  queryRect(bounds: Bounds, pad: number, cb: (item: T) => boolean | void): void {
    const seen = new Set<T>();
    let stop = false;
    const indexed = this.forEachCellKey(
      {
        minX: bounds.minX - pad,
        minY: bounds.minY - pad,
        maxX: bounds.maxX + pad,
        maxY: bounds.maxY + pad,
      },
      (key) => {
        if (stop) return;
        const bucket = this.cells.get(key);
        if (!bucket) return;
        for (const item of bucket) {
          if (seen.has(item)) continue;
          seen.add(item);
          if (cb(item) === true) {
            stop = true;
            return;
          }
        }
      },
    );
    // Including all overflow items is conservative: callers perform the exact
    // intersection test. Preserve query early exit and visit each item once.
    for (const item of indexed ? this.overflow : this.bounds.keys()) {
      if (stop) break;
      if (seen.has(item)) continue;
      if (cb(item) === true) stop = true;
    }
  }

  /** Visit every item whose cells intersect a segment's bounding box (padded). */
  querySegment(
    a: { x: number; y: number },
    b: { x: number; y: number },
    pad: number,
    cb: (item: T) => boolean | void,
  ): void {
    this.queryRect(
      {
        minX: Math.min(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x),
        maxY: Math.max(a.y, b.y),
      },
      pad,
      cb,
    );
  }
}
