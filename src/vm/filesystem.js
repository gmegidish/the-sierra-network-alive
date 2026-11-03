// In-memory DOS filesystem backed by the installed INN tree. Names are
// case-insensitive and normalised to upper case with backslashes stripped of
// "./" and ".\" prefixes; writes stay in memory. A land program runs with
// its own current directory (TSN.PRG "cd LL"), so names resolve against
// `cwd` and "..\" climbs back to the install root.

/** @param {string} name */
export function normalizePath(name) {
  return name.replace(/[/\\]+/g, '\\').replace(/^(\.\\)+/, '').toUpperCase();
}

/** Drop "." and fold ".." in a normalised path. @param {string} path */
function foldDots(path) {
  const parts = [];
  for (const part of path.split('\\')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  return parts.join('\\');
}

export class FileSystem {
  /** @param {Map<string, Uint8Array>} files keyed by path relative to the install root */
  constructor(files) {
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
    for (const [name, bytes] of files) {
      this.files.set(normalizePath(name), bytes);
    }
    this.cwd = '';
  }

  /** The same files seen from another directory (writes are shared). @param {string} dir */
  inDirectory(dir) {
    const view = Object.create(FileSystem.prototype);
    view.files = this.files;
    view.cwd = foldDots(normalizePath(dir));
    return view;
  }

  /** Install-relative key for a DOS name. @param {string} name */
  resolve(name) {
    return foldDots(this.cwd ? `${this.cwd}\\${normalizePath(name)}` : normalizePath(name));
  }

  /**
   * Key of an existing file: in the current directory, else in the install root
   * (LSCI.CFG "pathStr = ..\\": the Clubhouse runs in CC but reads GAME.CFG and
   * GUIDE.CFG from the root). @param {string} name
   */
  locate(name) {
    const here = this.resolve(name);
    const inRoot = foldDots(normalizePath(name));
    return this.files.has(here) || !this.files.has(inRoot) ? here : inRoot;
  }

  exists(name) {
    return this.files.has(this.locate(name));
  }

  /** @returns {Uint8Array | undefined} */
  read(name) {
    return this.files.get(this.locate(name));
  }

  write(name, bytes) {
    this.files.set(this.resolve(name), bytes);
  }

  remove(name) {
    return this.files.delete(this.resolve(name));
  }

  /** True when some file lives under `name\`. */
  isDirectory(name) {
    const prefix = `${this.resolve(name)}\\`;
    return [...this.files.keys()].some((path) => path.startsWith(prefix));
  }

  /** File names matching a DOS wildcard pattern such as "*.TXT". */
  list(pattern) {
    const here = this.cwd ? `${this.cwd}\\` : '';
    const regex = new RegExp(`^${here.replace(/\\/g, '\\\\')}${normalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return [...this.files.keys()].filter((name) => regex.test(name)).map((name) => name.slice(here.length));
  }

  /** Text of a file, or undefined. */
  readText(name) {
    const bytes = this.read(name);
    return bytes ? new TextDecoder('latin1').decode(bytes) : undefined;
  }
}
