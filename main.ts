// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Shared per-run state for the format readers: --strict, and the moves that succeeded (for `R` output). */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

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

// ---------------------------------------------------------------------------
// Section 5: matching lines, and the shared file-line helpers (section 3).
// ---------------------------------------------------------------------------

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** One line of O (old) or N (new): a context line lives in both, an old/new line in one. */
interface OLine {
  text: string;
  kind: 'ctx' | 'old';
}
interface NLine {
  text: string;
  kind: 'ctx' | 'new';
}

function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions. */
function firstTier(lines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * The lines that replace O at `pos`: a context line is written as the file's own matched line, never the patch's;
 * at tier 2 every other N line is re-indented (F for P, where F/P are the leading spaces/tabs of the file's and
 * O's first matched line). At tiers 0 and 1 N's lines are written as they are.
 */
function buildReplacement(fileLines: string[], O: OLine[], N: NLine[], pos: number, tier: number): string[] {
  const oCtx: number[] = [];
  O.forEach((e, i) => {
    if (e.kind === 'ctx') oCtx.push(i);
  });
  let ci = 0;
  const res: { text: string; kind: string }[] = [];
  for (const e of N) {
    if (e.kind === 'ctx') {
      res.push({ text: fileLines[pos + oCtx[ci]!]!, kind: 'ctx' });
      ci += 1;
    } else {
      res.push({ text: e.text, kind: 'new' });
    }
  }
  if (tier === 2 && O.length > 0) {
    const F = leadWs(fileLines[pos]!);
    const P = leadWs(O[0]!.text);
    for (const r of res) {
      if (r.kind !== 'ctx' && r.text !== '' && r.text.trim() !== '' && r.text.startsWith(P)) {
        r.text = F + r.text.slice(P.length);
      }
    }
  }
  return res.map((r) => r.text);
}

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed, a/b/ removed. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  const p = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
  return p === '/dev/null' ? null : p;
}

interface UHunk {
  A: number;
  body: string[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  oldSet: boolean; // named by a ---/+++ pair (which beats rename from/to)
  newSet: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

function hunkON(body: string[]): { O: OLine[]; N: NLine[] } {
  const O: OLine[] = [];
  const N: NLine[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      O.push({ text: t, kind: 'ctx' });
      N.push({ text: t, kind: 'ctx' });
    } else if (l[0] === '-') O.push({ text: l.slice(1), kind: 'old' });
    else if (l[0] === '+') N.push({ text: l.slice(1), kind: 'new' });
  }
  return { O, N };
}

/** True when a `\` line follows the hunk body's last context or `+` line. */
function bodyNoEol(body: string[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      return i + 1 < body.length && body[i + 1]!.startsWith('\\');
    }
  }
  return false;
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      // The form is `diff --git a/<X> b/<Y>`: anything else on the line is a parse error.
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (!m || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, oldSet: false, newSet: false, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur.oldPath = dashPath(l);
        cur.newPath = dashPath(lines[i + 1]!);
        cur.oldSet = true;
        cur.newSet = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = { oldPath: dashPath(l), newPath: dashPath(lines[i + 1]!), oldSet: true, newSet: true, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ A: parseInt(hm[1]!, 10), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) {
        cur.newPath = dashPath(l);
        cur.newSet = true;
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur.oldSet) cur.oldPath = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.newSet) cur.newPath = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, ctx));
}

function unifiedEdit(sec: USection, ctx: Ctx): Edit {
  const isCreate = sec.newFile || sec.oldPath === null;
  const isDelete = !isCreate && (sec.deletedFile || sec.newPath === null);
  const isMove = !isCreate && !isDelete && sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath;
  return (tree) => {
    if (isCreate) {
      const p = sec.newPath;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const l of h.body) if (l[0] === '+') plus.push(l.slice(1));
      let noEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.body.some((l) => l[0] === '+')) {
          noEol = bodyNoEol(h.body);
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    const oldP = sec.oldPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const newP = sec.newPath!;
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const st = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N } = hunkON(h.body);
      if (O.length === 0) {
        const at = Math.max(0, Math.min(h.A + d, st.lines.length));
        const atEnd = at === st.lines.length;
        const texts = N.map((e) => e.text);
        st.lines.splice(at, 0, ...texts);
        if (atEnd && texts.length > 0) st.final = !bodyNoEol(h.body);
        d += N.length;
        continue;
      }
      const found = firstTier(st.lines, O.map((e) => e.text), ctx.strict);
      if (found === null) throw new Fail('no-match', oldP);
      const target = h.A - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + O.length === st.lines.length;
      const repl = buildReplacement(st.lines, O, N, best, found.tier);
      st.lines.splice(best, O.length, ...repl);
      if (runsToEnd) st.final = repl.length === 0 ? best > 0 : !bodyNoEol(h.body);
      d += N.length - O.length;
    }
    const out = joinFile(st);
    if (isMove) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      ctx.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], ctx: Ctx): Edit[] {
  const searchIdx: number[] = [];
  lines.forEach((l, i) => {
    if (l.trimEnd() === '<<<<<<< SEARCH') searchIdx.push(i);
  });
  if (searchIdx.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let k = 0; k < searchIdx.length; k++) {
    const si = searchIdx[k]!;
    const nextSearch = k + 1 < searchIdx.length ? searchIdx[k + 1]! : lines.length;
    let path: string | null = null;
    for (let j = si - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < nextSearch; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < nextSearch; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, ctx));
    prevPath = path;
    prevEnd = rep;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const O: OLine[] = oldLines.map((t) => ({ text: t, kind: 'old' as const }));
    const N: NLine[] = newLines.map((t) => ({ text: t, kind: 'new' as const }));
    const found = firstTier(st.lines, oldLines, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const repl = buildReplacement(st.lines, O, N, pos, found.tier);
    st.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(st));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VEntry {
  text: string;
  num: number;
}
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: VEntry[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  lines: VEntry[];
}

/** First line at or after `cursor` equal to the anchor, at the first tier where one is (single-line match). */
function anchorFind(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add') ? ('add' as const) : l.startsWith('*** Delete') ? ('delete' as const) : ('update' as const);
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: l.slice(prefix.length).trim(), headerLine: i + 1, lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.lines.push({ text: l, num: i + 1 });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  for (const s of sections) {
    while (s.lines.length > 0 && blank(s.lines[s.lines.length - 1]!.text)) s.lines.pop();
  }
  return sections.map((s) => v4aEdit(s, ctx));
}

function v4aEdit(sec: VSection, ctx: Ctx): Edit {
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const e of sec.lines) {
      if (e.text.startsWith('+')) fileLines.push(e.text.slice(1));
      else if (blank(e.text)) fileLines.push('');
      else throw new Exit2(`error: parse ${e.num}`);
    }
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    for (const e of sec.lines) {
      if (!blank(e.text)) throw new Exit2(`error: parse ${e.num}`);
    }
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (sec.lines.length > 0 && sec.lines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = sec.lines[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  let closed = false;
  for (; idx < sec.lines.length; idx++) {
    const e = sec.lines[idx]!;
    if (e.text.startsWith('@@')) {
      curChunk = { anchor: e.text.slice(2).trim(), eof: false, body: [] };
      chunks.push(curChunk);
      closed = false;
      continue;
    }
    if (e.text.trimEnd() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${e.num}`);
      curChunk.eof = true;
      curChunk = null;
      closed = true;
      continue;
    }
    if (e.text === '' || e.text[0] === ' ' || e.text[0] === '-' || e.text[0] === '+') {
      if (curChunk === null) {
        if (chunks.length === 0 && !closed) {
          curChunk = { anchor: null, eof: false, body: [] };
          chunks.push(curChunk);
        } else {
          throw new Exit2(`error: parse ${e.num}`);
        }
      }
      curChunk.body.push(e);
      continue;
    }
    throw new Exit2(`error: parse ${e.num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.headerLine}`);
  const move = moveTo;
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (move !== null && !safe(move)) throw new Fail('unsafe', move);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const st = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const ai = anchorFind(st.lines, ch.anchor, cursor, ctx.strict);
        if (ai === null) throw new Fail('no-match', sec.path);
        cursor = ai + 1;
      }
      const O: OLine[] = [];
      const N: NLine[] = [];
      for (const be of ch.body) {
        const t = be.text;
        if (t === '' || t[0] === ' ') {
          const x = t === '' ? '' : t.slice(1);
          O.push({ text: x, kind: 'ctx' });
          N.push({ text: x, kind: 'ctx' });
        } else if (t[0] === '-') O.push({ text: t.slice(1), kind: 'old' });
        else if (t[0] === '+') N.push({ text: t.slice(1), kind: 'new' });
      }
      if (O.length === 0) {
        const pos = ch.eof ? st.lines.length : cursor;
        const texts = N.map((e) => e.text);
        st.lines.splice(pos, 0, ...texts);
        cursor = pos + texts.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const maxTier = ctx.strict ? 0 : 2;
      for (let t = 0; t <= maxTier && found === null; t++) {
        for (let i2 = cursor; i2 + O.length <= st.lines.length; i2++) {
          if (ch.eof && i2 + O.length !== st.lines.length) continue;
          let ok = true;
          for (let j = 0; j < O.length; j++) {
            if (!lineEq(st.lines[i2 + j]!, O[j]!.text, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            found = { tier: t, pos: i2 };
            break;
          }
        }
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const repl = buildReplacement(st.lines, O, N, found.pos, found.tier);
      st.lines.splice(found.pos, O.length, ...repl);
      cursor = found.pos + repl.length;
    }
    const out = joinFile(st);
    if (move !== null) {
      tree.now.set(move, out);
      tree.now.set(sec.path, null);
      ctx.moves.push([sec.path, move]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, ctx)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, ctx)
            : v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of ctx.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.text);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
