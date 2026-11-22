// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits,
// matches old lines at three tiers (exact, trailing-whitespace-insensitive,
// indent-insensitive) and applies every edit or none. Node 22 standard
// library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below).

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
  readonly moves: { old: string; new: string }[] = [];
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

// ---- file lines (SPEC section 3) ----

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---- matching lines (SPEC section 5) ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function matchTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrencesAt(fileLines: string[], oldLines: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = Math.max(0, from); i + oldLines.length <= fileLines.length; i += 1) {
    if (eofOnly && i + oldLines.length !== fileLines.length) continue;
    let ok = true;
    for (let k = 0; k < oldLines.length; k += 1) {
      if (!matchTier(fileLines[i + k]!, oldLines[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

const tiersFor = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

function findTier(fileLines: string[], oldLines: string[], strict: boolean, from = 0, eofOnly = false): Found | null {
  const tiers = tiersFor(strict);
  for (const tier of tiers) {
    const positions = occurrencesAt(fileLines, oldLines, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NewEntry {
  text: string;
  ctxO: number | null;
}

/** Replacement lines for a match: context lines keep the file's own text; tier 2 re-indents the rest. */
function buildReplacement(fileLines: string[], pos: number, oldLines: string[], newEntries: NewEntry[], tier: number): string[] {
  const f = leadWS(fileLines[pos]!);
  const p = leadWS(oldLines[0]!);
  return newEntries.map((e) => {
    if (e.ctxO !== null) return fileLines[pos + e.ctxO]!;
    if (tier === 2 && e.text !== '' && !/^\s*$/.test(e.text) && e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

interface BodyEntry {
  kind: string;
  text: string;
}

function bodyEntries(body: string[]): BodyEntry[] {
  return body.map((bl) => {
    if (bl === '') return { kind: ' ', text: '' };
    if (bl[0] === '\\') return { kind: '\\', text: bl };
    return { kind: bl[0]!, text: bl.slice(1) };
  });
}

function oldNew(entries: BodyEntry[]): { oldLines: string[]; newEntries: NewEntry[] } {
  const oldLines: string[] = [];
  const ctxIndex = new Map<number, number>();
  entries.forEach((e, idx) => {
    if (e.kind === ' ' || e.kind === '-') {
      ctxIndex.set(idx, oldLines.length);
      oldLines.push(e.text);
    }
  });
  const newEntries: NewEntry[] = [];
  entries.forEach((e, idx) => {
    if (e.kind === ' ') newEntries.push({ text: e.text, ctxO: ctxIndex.get(idx)! });
    else if (e.kind === '+') newEntries.push({ text: e.text, ctxO: null });
  });
  return { oldLines, newEntries };
}

// ---- format detection (SPEC section 4) ----

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

// ---- JSON edits (SPEC section 9) ----

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

// ---- unified diffs (SPEC section 6) ----

interface UHunk {
  a: number;
  body: string[];
}

interface USection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  minusSet: boolean;
  minus: string | null;
  plusSet: boolean;
  plus: string | null;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
  headerDone: boolean;
}

function newSection(): USection {
  return {
    diffOld: undefined,
    diffNew: undefined,
    minusSet: false,
    minus: null,
    plusSet: false,
    plus: null,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
    headerDone: false,
  };
}

/** Path of a ---/+++ line: after the 4 chars, up to the first tab, spaces removed, a/ or b/ stripped. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.replace(/^ +/, '').replace(/ +$/, '');
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function backslashAfterLast(entries: BodyEntry[]): boolean {
  let last = -1;
  entries.forEach((e, idx) => {
    if (e.kind === ' ' || e.kind === '+') last = idx;
  });
  return last >= 0 && entries[last + 1]?.kind === '\\';
}

function applyUnified(text: string, hunks: UHunk[], strict: boolean, failPath: string): string {
  const parts = fileParts(text);
  const cur = [...parts.lines];
  let curFinal = parts.final;
  let d = 0;
  for (const hunk of hunks) {
    const entries = bodyEntries(hunk.body);
    const { oldLines, newEntries } = oldNew(entries);
    const bs = backslashAfterLast(entries);
    if (oldLines.length === 0) {
      const insertPos = Math.max(0, Math.min(hunk.a + d, cur.length));
      const touchesEnd = insertPos === cur.length;
      cur.splice(insertPos, 0, ...newEntries.map((n) => n.text));
      if (touchesEnd) curFinal = !bs;
      d += newEntries.length;
    } else {
      const found = findTier(cur, oldLines, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = hunk.a - 1 + d;
      let pos = found.positions[0]!;
      for (const cand of found.positions) {
        const dc = Math.abs(cand - target);
        const db = Math.abs(pos - target);
        if (dc < db || (dc === db && cand < pos)) pos = cand;
      }
      const touchesEnd = pos + oldLines.length === cur.length;
      const repl = buildReplacement(cur, pos, oldLines, newEntries, found.tier);
      cur.splice(pos, oldLines.length, ...repl);
      if (touchesEnd) curFinal = !bs;
      d += newEntries.length - oldLines.length;
    }
  }
  return joinFile(cur, parts.br, curFinal);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number.parseInt(hm[1]!, 10), body });
      cur.headerDone = true;
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const minus = headerPath(line);
      const plus = headerPath(lines[i + 1]!);
      if (cur !== null && !cur.headerDone) {
        cur.minusSet = true;
        cur.minus = minus;
        cur.plusSet = true;
        cur.plus = plus;
      } else {
        cur = newSection();
        cur.minusSet = true;
        cur.minus = minus;
        cur.plusSet = true;
        cur.plus = plus;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.plusSet = true;
        cur.plus = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => {
    const oldPath: string | null = sec.minusSet ? sec.minus : (sec.renameFrom ?? sec.diffOld ?? null);
    const newPath: string | null = sec.plusSet ? sec.plus : (sec.renameTo ?? sec.diffNew ?? null);
    const isCreate = (sec.minusSet && sec.minus === null) || sec.newFile;
    const isDelete = (sec.plusSet && sec.plus === null) || sec.delFile;
    const hunks = sec.hunks;
    return (tree: Tree): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (isCreate) {
        if (newPath === null) return;
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const added: string[] = [];
        let bs = false;
        let hasPlus = false;
        for (const hunk of hunks) {
          hunk.body.forEach((bl, idx) => {
            if (bl.startsWith('+')) {
              added.push(bl.slice(1));
              hasPlus = true;
              bs = (hunk.body[idx + 1] ?? '').startsWith('\\');
            }
          });
        }
        tree.now.set(newPath, joinFile(added, '\n', hasPlus ? !bs : false));
        return;
      }
      if (isDelete) {
        if (oldPath === null) return;
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath === null || newPath === null) return;
      if (oldPath !== newPath) {
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const after = applyUnified(before, hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, after);
        tree.moves.push({ old: oldPath, new: newPath });
        return;
      }
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, applyUnified(before, hunks, strict, oldPath));
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isReplace = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let sepIdx = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isSep(lines[j]!)) {
        sepIdx = j;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j += 1) {
      if (isReplace(lines[j]!)) {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevReplace; k -= 1) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sepIdx), newLines: lines.slice(sepIdx + 1, repIdx) });
    prevPath = path;
    prevReplace = repIdx;
    i = repIdx + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinFile(b.newLines, '\n', true));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = fileParts(before);
    const found = findTier(parts.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const repl = buildReplacement(
      parts.lines,
      pos,
      b.oldLines,
      b.newLines.map((t) => ({ text: t, ctxO: null })),
      found.tier,
    );
    const next = [...parts.lines];
    next.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinFile(next, parts.br, parts.final));
  });
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface VSec {
    kind: 'add' | 'del' | 'upd';
    path: string;
    lineNo: number;
    raw: { text: string; no: number }[];
  }
  const secs: VSec[] = [];
  let cur: VSec | null = null;
  for (let idx = first + 1; idx < last; idx += 1) {
    const line = lines[idx]!;
    const no = idx + 1;
    let kind: VSec['kind'] | null = null;
    if (line.startsWith('*** Add File:')) kind = 'add';
    else if (line.startsWith('*** Delete File:')) kind = 'del';
    else if (line.startsWith('*** Update File:')) kind = 'upd';
    if (kind !== null) {
      const path = line.slice(line.indexOf(':') + 1).trim();
      cur = { kind, path, lineNo: no, raw: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    cur.raw.push({ text: line, no });
  }
  const edits: Edit[] = [];
  for (const sec of secs) {
    while (sec.raw.length > 0 && blank(sec.raw[sec.raw.length - 1]!.text)) sec.raw.pop();
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of sec.raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const path = sec.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(fileLines, '\n', true));
      });
    } else if (sec.kind === 'del') {
      if (sec.raw.length > 0) throw new Exit2(`error: parse ${sec.raw[0]!.no}`);
      const path = sec.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let k = 0;
      while (k < sec.raw.length && blank(sec.raw[k]!.text)) k += 1;
      let moveTo: string | null = null;
      if (k < sec.raw.length && sec.raw[k]!.text.startsWith('*** Move to:')) {
        moveTo = sec.raw[k]!.text.slice(sec.raw[k]!.text.indexOf(':') + 1).trim();
        k += 1;
        while (k < sec.raw.length && blank(sec.raw[k]!.text)) k += 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let sawEof = false;
      for (; k < sec.raw.length; k += 1) {
        const r = sec.raw[k]!;
        const t = r.text;
        if (t.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, body: [], eof: true };
            chunks.push(chunk);
          } else chunk.eof = true;
          chunk = null;
          sawEof = true;
          continue;
        }
        if (t.startsWith('@@')) {
          const anchorText = t.slice(2).trim();
          chunk = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          chunks.push(chunk);
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            if (chunks.length === 0 && !sawEof) {
              chunk = { anchor: null, body: [], eof: false };
              chunks.push(chunk);
            } else throw new Exit2(`error: parse ${r.no}`);
          }
          chunk.body.push(t);
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      const path = sec.path;
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        if (chunks.length === 0) {
          tree.now.set(path, null);
          tree.now.set(mv!, before);
          tree.moves.push({ old: path, new: mv! });
          return;
        }
        const parts = fileParts(before);
        const curLines = [...parts.lines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const tiers = tiersFor(strict);
            let foundPos = -1;
            for (const tier of tiers) {
              for (let i2 = cursor; i2 < curLines.length; i2 += 1) {
                if (matchTier(curLines[i2]!, ch.anchor, tier)) {
                  foundPos = i2;
                  break;
                }
              }
              if (foundPos >= 0) break;
            }
            if (foundPos < 0) throw new Fail('no-match', path);
            cursor = foundPos + 1;
          }
          const { oldLines, newEntries } = oldNew(bodyEntries(ch.body));
          if (oldLines.length === 0) {
            const insertPos = ch.eof ? curLines.length : Math.min(cursor, curLines.length);
            curLines.splice(insertPos, 0, ...newEntries.map((n) => n.text));
            cursor = insertPos + newEntries.length;
          } else {
            const found = findTier(curLines, oldLines, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const repl = buildReplacement(curLines, pos, oldLines, newEntries, found.tier);
            curLines.splice(pos, oldLines.length, ...repl);
            cursor = pos + repl.length;
          }
        }
        const after = joinFile(curLines, parts.br, parts.final);
        if (mv !== null) {
          tree.now.set(path, null);
          tree.now.set(mv, after);
          tree.moves.push({ old: path, new: mv });
        } else tree.now.set(path, after);
      });
    }
  }
  return edits;
}

// ---- command line, output and atomic write (SPEC sections 1, 2, 10) ----

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
    else if (kind === 'search-replace') edits = searchEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k2, v] of beforeNow) tree.now.set(k2, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const consumed = new Set<string>();
  const rowList: { key: string; text: string }[] = [];
  for (const mv of tree.moves) {
    if (consumed.has(mv.old) || consumed.has(mv.new)) continue;
    const o = changed.get(mv.old);
    const n = changed.get(mv.new);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null) {
      rowList.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  for (const [p, ch] of changed) {
    if (consumed.has(p)) continue;
    rowList.push({ key: p, text: `${ch.was === null ? 'A' : ch.now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.text);
  if (!check) {
    for (const [p, ch] of changed) {
      if (ch.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, ch.now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
