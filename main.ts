// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection, the three
// matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// --- Lines of a file (SPEC.md section 3) ---

function brOf(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

interface FileLines {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const br = brOf(text);
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

// Leading/trailing spaces and tabs only: section 5 trims spaces and tabs, nothing else.
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const onlyWS = (s: string): boolean => /^[ \t]*$/.test(s);

/** Section 5, tier 2: replace a new line's leading P with F, unless it is empty or only whitespace. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || onlyWS(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// --- Matching lines (SPEC.md section 5) ---

function matchAtTier(fileLine: string, oLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oLine;
  if (tier === 1) return trimEndST(fileLine) === trimEndST(oLine);
  return trimST(fileLine) === trimST(oLine);
}

/** Positions i >= from where O's lines match the file's lines i, i+1, ... at the tier. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!matchAtTier(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 with --strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines that replace an occurrence: a context line is the file's own matched line, any other line is
 *  re-indented at tier 2 and written as it is at tiers 0 and 1. */
function buildReplacement(
  fileLines: string[],
  pos: number,
  o: string[],
  n: { text: string; ctx: boolean; oIdx: number }[],
  tier: number,
): string[] {
  const f = leadST(fileLines[pos] ?? '');
  const p = leadST(o[0] ?? '');
  return n.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oIdx]!;
    if (tier === 2) return reindent(nl.text, f, p);
    return nl.text;
  });
}

// --- Format detection (SPEC.md section 4) ---

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- JSON edits (SPEC.md section 9) ---

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Unified diffs (SPEC.md section 6) ---

interface Hunk {
  a: number;
  o: string[];
  n: { text: string; ctx: boolean; oIdx: number }[];
  noNL: boolean; // a \ line follows the hunk's last context or + line
  plusNoNL: boolean; // a \ line follows the hunk's last + line
}

interface Section {
  hOld: string | null;
  hNew: string | null;
  rOld: string | null;
  rNew: string | null;
  dX: string | null;
  dY: string | null;
  createF: boolean;
  delF: boolean;
  hunks: Hunk[];
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not a well-formed one. */
function parseDiffGit(line: string): { x: string; y: string } | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length).trimEnd();
  if (!rest.startsWith('a/')) return null;
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  const x = rest.slice(2, k);
  const y = rest.slice(k + 3);
  if (x === '' || y === '') return null;
  return { x, y };
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, surrounding spaces
 *  removed, a leading a/ or b/ removed. */
function headerPath(line: string): string {
  let s = line.slice(4).split('\t')[0]!;
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** `@@ -A[,B] +C[,D] @@`, optionally followed by text; B and D are not used. */
function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { a: Number(m[1]) };
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: { text: string; ctx: boolean; oIdx: number }[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: true, oIdx: o.length - 1 });
      lastCtxOrPlus = i;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxOrPlus = i;
      lastPlus = i;
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxOrPlus = i;
    }
    // a \ line is a marker, not content
  }
  const noNL = lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]!.startsWith('\\');
  const plusNoNL = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { a, o, n, noNL, plusNoNL };
}

/** Apply a section's hunks in order to a file's text. Throws Fail('no-match', path) on a hunk that finds nothing. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { lines, br, fin } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at >= lines.length;
      const ins = h.n.map((nl) => nl.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) fin = !h.noNL;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        best = dd;
        pos = p;
      }
    }
    const rep = buildReplacement(lines, pos, h.o, h.n, found.tier);
    const endPos = pos + h.o.length;
    const runsToEnd = endPos >= lines.length;
    lines = [...lines.slice(0, pos), ...rep, ...lines.slice(endPos)];
    if (runsToEnd) fin = !h.noNL;
    d += h.n.length - h.o.length;
  }
  return joinFile(lines, br, fin);
}

function sectionToEdit(sec: Section, strict: boolean): Edit {
  const oldRaw = sec.hOld ?? sec.rOld ?? sec.dX;
  const newRaw = sec.hNew ?? sec.rNew ?? sec.dY;
  const create = sec.createF || oldRaw === '/dev/null';
  const del = sec.delF || newRaw === '/dev/null';
  const oldP = oldRaw === '/dev/null' ? null : oldRaw;
  const newP = newRaw === '/dev/null' ? null : newRaw;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (create) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const content: string[] = [];
      let fin = true;
      let sawPlus = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const nl of h.n) {
          if (!nl.ctx) {
            content.push(nl.text);
            hasPlus = true;
          }
        }
        if (hasPlus) {
          fin = !h.plusNoNL;
          sawPlus = true;
        }
      }
      tree.now.set(np, !sawPlus ? '' : content.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (del) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP!;
      const np = newP!;
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(text, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push({ from: op, to: np });
      return;
    }
    const p = oldP!;
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const newSection = (dX: string | null, dY: string | null): Section => {
    const s: Section = { hOld: null, hNew: null, rOld: null, rNew: null, dX, dY, createF: false, delF: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(dg.x, dg.y);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.hOld = headerPath(l);
        cur.hNew = headerPath(lines[i + 1]!);
      } else {
        const s = newSection(null, null);
        s.hOld = headerPath(l);
        s.hNew = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunkHeader(l);
      if (h === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(h.a, body));
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.hNew = headerPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.rOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.rNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.createF = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delF = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionToEdit(s, strict));
}

// --- SEARCH/REPLACE blocks (SPEC.md section 7) ---

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (eq < 0 && lines[j]!.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p, o, nw) => (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const { lines: fl, br, fin } = splitFile(text);
      const found = findTier(fl, o, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const repLines = nw.map((nl) => (found.tier === 2 ? reindent(nl, leadST(fl[pos]!), leadST(o[0]!)) : nl));
      tree.now.set(p, joinFile([...fl.slice(0, pos), ...repLines, ...fl.slice(pos + o.length)], br, fin));
    })(path, oldLines, newLines));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// --- V4A patches (SPEC.md section 8) ---

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: { text: string; ctx: boolean; oIdx: number }[];
  eof: boolean;
}

function isV4ASectionStart(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      i++;
      const sec: { text: string; num: number }[] = [];
      while (i < end && !isV4ASectionStart(lines[i]!)) {
        sec.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      const fileLines: string[] = [];
      for (const sl of sec) {
        if (sl.text === '') fileLines.push('');
        else if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
        else throw new Exit2(`error: parse ${sl.num}`);
      }
      edits.push(((p, fl) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      i++;
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      const updateNum = i + 1;
      i++;
      const sec: { text: string; num: number }[] = [];
      while (i < end && !isV4ASectionStart(lines[i]!)) {
        sec.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      edits.push(makeV4AUpdate(path, updateNum, sec, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function makeV4AUpdate(path: string, updateNum: number, sec: { text: string; num: number }[], strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (sec.length > 0 && sec[0]!.text.startsWith('*** Move to:')) {
    moveTo = sec[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: { anchor: string | null; body: { text: string; num: number }[]; eof: boolean } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const o: string[] = [];
    const n: { text: string; ctx: boolean; oIdx: number }[] = [];
    for (const bl of cur.body) {
      const l = bl.text;
      if (l.startsWith(' ')) {
        o.push(l.slice(1));
        n.push({ text: l.slice(1), ctx: true, oIdx: o.length - 1 });
      } else if (l.startsWith('-')) {
        o.push(l.slice(1));
      } else if (l.startsWith('+')) {
        n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      } else if (l === '') {
        o.push('');
        n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      }
    }
    chunks.push({ anchor: cur.anchor, o, n, eof: cur.eof });
    cur = null;
  };
  while (idx < sec.length) {
    const { text, num } = sec[idx]!;
    if (text.startsWith('@@')) {
      flush();
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      idx++;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      flush();
      idx++;
      continue;
    }
    if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push({ text, num });
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, fin } = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (matchAtTier(lines[k]!, ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = ch.n.map((nl) => nl.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      if (ch.eof) {
        const at = lines.length - ch.o.length;
        if (at < cursor) throw new Fail('no-match', path);
        let tier = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          let ok = true;
          for (let j = 0; j < ch.o.length; j++) {
            if (!matchAtTier(lines[at + j]!, ch.o[j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            tier = t;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const rep = buildReplacement(lines, at, ch.o, ch.n, tier);
        lines = [...lines.slice(0, at), ...rep, ...lines.slice(at + ch.o.length)];
        cursor = at + rep.length;
        continue;
      }
      const found = findTier(lines, ch.o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const rep = buildReplacement(lines, pos, ch.o, ch.n, found.tier);
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + ch.o.length)];
      cursor = pos + rep.length;
    }
    const out = joinFile(lines, br, fin);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// --- Running the CLI (SPEC.md sections 1, 2, 10) ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move whose old path is gone and whose new path is there is one R line, replacing its D and A lines.
  const rPairs: Array<{ from: string; to: string }> = [];
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      rPairs.push(m);
    }
  }
  const rFrom = new Set(rPairs.map((r) => r.from));
  const rTo = new Set(rPairs.map((r) => r.to));
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rFrom.has(p) || rTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const r of rPairs) rows.push({ key: r.to, line: `R ${r.from} -> ${r.to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
