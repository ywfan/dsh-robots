/** Synthetic examples for the review pilot. These functions are never called by the plugin. */
type Write = (path: string, text: string) => Promise<void>;
type Move = (from: string, to: string) => Promise<void>;
type Remove = (path: string) => Promise<void>;

// Fixture A: the writer may create a partial temporary file before rejecting.
export async function writeA(write: Write, move: Move, remove: Remove, path: string, text: string) {
  const temporary = path + '.tmp';
  await write(temporary, text);
  try {
    await move(temporary, path);
  } finally {
    await remove(temporary);
  }
}

// Fixture B: the same rejection still reaches the cleanup.
export async function writeB(write: Write, move: Move, remove: Remove, path: string, text: string) {
  const temporary = path + '.tmp';
  try {
    await write(temporary, text);
    await move(temporary, path);
  } finally {
    await remove(temporary);
  }
}
