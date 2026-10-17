// Errors are values with a path (plan §4.3): `objects.order.fields.payment: unknown enum "cod"`.
// The Architect feeds them back to the patcher, so compile collects every error of a stage before failing.

export class CompileError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'CompileError';
  }
}

export class CompileFailure extends Error {
  constructor(readonly errors: CompileError[]) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'CompileFailure';
  }
}

export class Errors {
  readonly list: CompileError[] = [];
  add(path: string, detail: string): void {
    this.list.push(new CompileError(path, detail));
  }
  throwIfAny(): void {
    if (this.list.length) throw new CompileFailure([...this.list]);
  }
}
