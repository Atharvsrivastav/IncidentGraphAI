export interface PriorityNode<T> {
  item: T;
  priority: number;
}

export type HeapType = "MAX" | "MIN";

/**
 * Priority Queue implemented via a Binary Heap.
 *
 * MAX Heap: highest priority number extracted first (used for Root Cause ranking score).
 * MIN Heap: lowest priority number extracted first (e.g. Dijkstra or earliest timestamp).
 *
 * Time Complexities:
 * - insert: O(log N)
 * - extract: O(log N)
 * - peek: O(1)
 * - size: O(1)
 * - buildHeap: O(N)
 * Space Complexity: O(N)
 */
export class PriorityQueue<T> {
  private heap: PriorityNode<T>[] = [];
  private readonly type: HeapType;

  constructor(type: HeapType = "MAX", initialItems?: PriorityNode<T>[]) {
    this.type = type;
    if (initialItems && initialItems.length > 0) {
      this.heap = [...initialItems];
      this.buildHeap();
    }
  }

  public size(): number {
    return this.heap.length;
  }

  public isEmpty(): boolean {
    return this.heap.length === 0;
  }

  public peek(): PriorityNode<T> | undefined {
    return this.heap[0];
  }

  public insert(item: T, priority: number): void {
    const node: PriorityNode<T> = { item, priority };
    this.heap.push(node);
    this.siftUp(this.heap.length - 1);
  }

  public extract(): PriorityNode<T> | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const root = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.siftDown(0);
    return root;
  }

  /**
   * Extracts top K elements in descending (MAX) or ascending (MIN) order.
   * Complexity: O(K log N)
   */
  public extractTopK(k: number): PriorityNode<T>[] {
    const count = Math.min(k, this.heap.length);
    const result: PriorityNode<T>[] = [];
    for (let i = 0; i < count; i++) {
      const node = this.extract();
      if (node) result.push(node);
    }
    return result;
  }

  public toArray(): PriorityNode<T>[] {
    return [...this.heap];
  }

  public clear(): void {
    this.heap = [];
  }

  private compare(a: number, b: number): boolean {
    return this.type === "MAX" ? a > b : a < b;
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.heap[current].priority, this.heap[parent].priority)) {
        this.swap(current, parent);
        current = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(index: number): void {
    let current = index;
    const length = this.heap.length;

    while (true) {
      const left = 2 * current + 1;
      const right = 2 * current + 2;
      let target = current;

      if (left < length && this.compare(this.heap[left].priority, this.heap[target].priority)) {
        target = left;
      }
      if (right < length && this.compare(this.heap[right].priority, this.heap[target].priority)) {
        target = right;
      }

      if (target !== current) {
        this.swap(current, target);
        current = target;
      } else {
        break;
      }
    }
  }

  private buildHeap(): void {
    const startIndex = Math.floor(this.heap.length / 2) - 1;
    for (let i = startIndex; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}
