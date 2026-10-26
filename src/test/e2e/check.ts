export async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    return true;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.error(e instanceof Error ? e.message : e);
    return false;
  }
}

export async function assertRejects(p: Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export function finish(results: boolean[]): void {
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}
