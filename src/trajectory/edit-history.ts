/** Immutable editor snapshots, with one undo step per pointer gesture. */
export class EditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private group: number | null = null;
  constructor(
    public current: T,
    private equal: (a: T, b: T) => boolean = Object.is,
    private limit = 100,
  ) {}
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  record(next: T, group: number | null = null) {
    if (this.equal(this.current, next)) return false;
    if (group === null || group !== this.group) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = next;
    this.future = [];
    this.group = group;
    if (this.past.length && this.equal(this.past.at(-1)!, next))
      this.past.pop();
    return true;
  }
  undo() {
    if (!this.canUndo) return null;
    this.future.push(this.current);
    this.current = this.past.pop()!;
    this.group = null;
    return this.current;
  }
  redo() {
    if (!this.canRedo) return null;
    this.past.push(this.current);
    this.current = this.future.pop()!;
    this.group = null;
    return this.current;
  }
}
