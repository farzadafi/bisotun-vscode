export class CycleDetector {
  private readonly visited = new Set<string>();

  hasVisited(key: string): boolean {
    return this.visited.has(key);
  }

  markVisited(key: string): void {
    this.visited.add(key);
  }

  clear(): void {
    this.visited.clear();
  }
}
