#!/usr/bin/env node
'use strict';
// kflat-lsp: thin LSP bridge over komp's machine-readable output.
//
// Zero dependencies. Speaks LSP over stdio. On didOpen/didSave it finds the
// saved file's crate root (nearest kf.toml), shells out to
// `komp check --diagnostic-format=json`, and republishes the NDJSON
// diagnostics as textDocument/publishDiagnostics. Outline, folding, hover,
// inlay-hint, selection-range, signature-help, go-to-definition,
// find-references and semantic-token requests shell out to `komp query`
// for the one file instead. It never parses .kf itself; the compiler is
// the single
// source of truth.
//
// Configuration: set KOMP_BIN to the komp binary (default: "komp" on PATH).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const KOMP_BIN = process.env.KOMP_BIN || 'komp';
const CHECK_TIMEOUT_MS = 30000;
// A parse-only query returns in milliseconds. A typed one (hover, inlay
// hints, signature help) checks the whole crate, so it is closer to a
// `komp check`.
const QUERY_TIMEOUT_MS = 5000;
const TYPED_QUERY_TIMEOUT_MS = 30000;

let positionEncoding = 'utf-16';
let shuttingDown = false;

// ---------------------------------------------------------------- transport

let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  pump();
});

function pump() {
  for (;;) {
    const headerEnd = inbuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = inbuf.subarray(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      inbuf = inbuf.subarray(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (inbuf.length < bodyStart + len) return;
    const body = inbuf.subarray(bodyStart, bodyStart + len).toString('utf8');
    inbuf = inbuf.subarray(bodyStart + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      log('dropped unparseable message');
      continue;
    }
    handle(msg);
  }
}

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, code, message) {
  send({ id, error: { code, message } });
}

function notify(method, params) {
  send({ method, params });
}

function log(message) {
  notify('window/logMessage', { type: 4, message: `kflat-lsp: ${message}` });
}

// ----------------------------------------------------------------- dispatch

function handle(msg) {
  if (msg.method === undefined) return; // response to a server request; none sent
  const isRequest = msg.id !== undefined;
  switch (msg.method) {
    case 'initialize': {
      const offered = msg.params?.capabilities?.general?.positionEncodings ?? [];
      if (offered.includes('utf-8')) positionEncoding = 'utf-8';
      const capabilities = {
        textDocumentSync: { openClose: true, change: 0, save: true },
        documentSymbolProvider: true,
        foldingRangeProvider: true,
        hoverProvider: true,
        inlayHintProvider: true,
        selectionRangeProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ','] },
        completionProvider: { triggerCharacters: ['.'] },
        renameProvider: { prepareProvider: true },
        referencesProvider: true,
        definitionProvider: true,
        semanticTokensProvider: { legend: SEMANTIC_LEGEND, full: true },
        codeActionProvider: { codeActionKinds: ['quickfix'] },
      };
      if (positionEncoding === 'utf-8') capabilities.positionEncoding = 'utf-8';
      respond(msg.id, {
        capabilities,
        serverInfo: { name: 'kflat-lsp', version: '0.1.0' },
      });
      break;
    }
    case 'shutdown':
      shuttingDown = true;
      respond(msg.id, null);
      break;
    case 'exit':
      process.exit(shuttingDown ? 0 : 1);
      break;
    case 'textDocument/didOpen':
    case 'textDocument/didSave': {
      const uri = msg.params.textDocument.uri;
      if (!uri.startsWith('file:')) break;
      const filePath = fileURLToPath(uri);
      const root = crateRootFor(filePath);
      if (root) scheduleCheck(root);
      else log(`no kf.toml found above ${filePath}; not checking`);
      break;
    }
    case 'textDocument/codeAction': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, []);
      // Answered from the fixes carried by the last published diagnostics
      // rather than by re-checking: a client asks for code actions on every
      // cursor move, and a crate check is far too expensive for that.
      respond(msg.id, codeActionsFor(filePath, msg.params.range));
      break;
    }
    case 'textDocument/documentSymbol': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, []);
      runQuery('symbols', filePath, [], (answer) => {
        const mapper = offsetMapper(filePath);
        if (!answer || !mapper) return respond(msg.id, []);
        respond(msg.id, (answer.symbols ?? []).map((s) => toLspSymbol(s, mapper)));
      });
      break;
    }
    case 'textDocument/foldingRange': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, []);
      runQuery('folding', filePath, [], (answer) => {
        const mapper = offsetMapper(filePath);
        if (!answer || !mapper) return respond(msg.id, []);
        respond(msg.id, toLspFoldingRanges(answer.ranges ?? [], mapper));
      });
      break;
    }
    case 'textDocument/hover': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, null);
      const offset = byteOffsetOf(filePath, msg.params.position);
      if (offset === null) return respond(msg.id, null);
      runQuery('hover', filePath, ['--offset', String(offset)], (answer) => {
        const mapper = offsetMapper(filePath);
        if (!answer || !mapper) return respond(msg.id, null);
        const value = hoverMarkdown(answer);
        if (!value) return respond(msg.id, null);
        const hover = { contents: { kind: 'markdown', value } };
        // A declaration's own name covers no expression, so there is no
        // span to highlight — and an empty range at 0 would highlight the
        // top of the file.
        if (answer.byte_end > answer.byte_start) {
          hover.range = { start: mapper(answer.byte_start), end: mapper(answer.byte_end) };
        }
        respond(msg.id, hover);
      });
      break;
    }
    case 'textDocument/inlayHint': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, []);
      runQuery('inlays', filePath, [], (answer) => {
        const mapper = offsetMapper(filePath);
        if (!answer || !mapper) return respond(msg.id, []);
        respond(msg.id, toLspInlayHints(answer.inlays ?? [], msg.params.range, mapper));
      });
      break;
    }
    case 'textDocument/selectionRange': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, []);
      const mapper = offsetMapper(filePath);
      if (!mapper) return respond(msg.id, []);
      // One chain per requested position, and the protocol wants them in
      // the order the positions came in.
      const positions = msg.params.positions ?? [];
      const chains = [];
      let pending = positions.length;
      if (pending === 0) return respond(msg.id, []);
      positions.forEach((position, index) => {
        const offset = byteOffsetOf(filePath, position);
        runQuery('selection', filePath, ['--offset', String(offset)], (answer) => {
          chains[index] = toLspSelectionRange(answer ? answer.ranges ?? [] : [], mapper);
          pending -= 1;
          if (pending === 0) respond(msg.id, chains);
        });
      });
      break;
    }
    case 'textDocument/prepareRename': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, null);
      const offset = byteOffsetOf(filePath, msg.params.position);
      if (offset === null) return respond(msg.id, null);
      // No new name yet: the client is asking whether renaming is possible
      // at all, and shows the reason when it is not.
      runQuery('rename', filePath, ['--offset', String(offset)], (answer) => {
        if (!answer) return respond(msg.id, null);
        if (!answer.ok) return respondError(msg.id, -32602, answer.error ?? 'cannot rename here');
        if (!answer.range) return respondError(msg.id, -32602, 'cannot rename here');
        const mapper = offsetMapper(filePath);
        if (!mapper) return respond(msg.id, null);
        respond(msg.id, { start: mapper(answer.range.byte_start), end: mapper(answer.range.byte_end) });
      });
      break;
    }
    case 'textDocument/rename': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, null);
      const offset = byteOffsetOf(filePath, msg.params.position);
      if (offset === null) return respond(msg.id, null);
      const args = ['--offset', String(offset), '--new-name', String(msg.params.newName ?? '')];
      runQuery('rename', filePath, args, (answer) => {
        if (!answer) return respond(msg.id, null);
        // A refusal is an error, not an empty edit: an editor that gets
        // `{}` reports "renamed" and changes nothing.
        if (!answer.ok) return respondError(msg.id, -32602, answer.error ?? 'cannot rename here');
        respond(msg.id, { changes: toWorkspaceChanges(answer.edits ?? [], msg.params.newName) });
      });
      break;
    }
    case 'textDocument/completion': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, []);
      const offset = byteOffsetOf(filePath, msg.params.position);
      if (offset === null) return respond(msg.id, []);
      runQuery('completion', filePath, ['--offset', String(offset)], (answer) => {
        if (!answer) return respond(msg.id, []);
        respond(msg.id, (answer.items ?? []).map(toCompletionItem));
      });
      break;
    }
    case 'textDocument/signatureHelp': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, null);
      const offset = byteOffsetOf(filePath, msg.params.position);
      if (offset === null) return respond(msg.id, null);
      runQuery('signature', filePath, ['--offset', String(offset)], (answer) => {
        if (!answer || typeof answer.label !== 'string') return respond(msg.id, null);
        respond(msg.id, {
          signatures: [
            {
              label: answer.label,
              parameters: (answer.parameters ?? []).map((p) => ({ label: p.label })),
            },
          ],
          activeSignature: 0,
          activeParameter: answer.active_parameter ?? 0,
        });
      });
      break;
    }
    case 'textDocument/semanticTokens/full': {
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, { data: [] });
      runQuery('tokens', filePath, [], (answer) => {
        const mapper = offsetMapper(filePath);
        if (!answer || !mapper) return respond(msg.id, { data: [] });
        respond(msg.id, { data: encodeSemanticTokens(answer.tokens ?? [], mapper) });
      });
      break;
    }
    case 'textDocument/references':
    case 'textDocument/definition': {
      const wantsDefinition = msg.method === 'textDocument/definition';
      const filePath = localPath(msg.params.textDocument.uri);
      if (!filePath) return respond(msg.id, wantsDefinition ? null : []);
      const offset = byteOffsetOf(filePath, msg.params.position);
      if (offset === null) return respond(msg.id, wantsDefinition ? null : []);
      runQuery('references', filePath, ['--offset', String(offset)], (answer) => {
        if (!answer) return respond(msg.id, wantsDefinition ? null : []);
        if (wantsDefinition) {
          return respond(msg.id, answer.declaration ? toLspLocation(answer.declaration) : null);
        }
        respond(msg.id, (answer.references ?? []).map(toLspLocation));
      });
      break;
    }
    default:
      if (isRequest) respondError(msg.id, -32601, `unhandled method ${msg.method}`);
      break;
  }
}

function localPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  return fileURLToPath(uri);
}

// -------------------------------------------------------------- crate roots

const rootCache = new Map(); // dir -> crate root or null

function crateRootFor(filePath) {
  let dir = path.dirname(filePath);
  const walked = [];
  while (true) {
    if (rootCache.has(dir)) {
      const root = rootCache.get(dir);
      for (const d of walked) rootCache.set(d, root);
      return root;
    }
    walked.push(dir);
    if (fs.existsSync(path.join(dir, 'kf.toml'))) {
      for (const d of walked) rootCache.set(d, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const d of walked) rootCache.set(d, null);
      return null;
    }
    dir = parent;
  }
}

// ------------------------------------------------------------ check running

// Per crate root: { running, dirty, published: Set<filePath> }
const roots = new Map();

function rootState(root) {
  let s = roots.get(root);
  if (!s) {
    s = { running: false, dirty: false, published: new Set() };
    roots.set(root, s);
  }
  return s;
}

function scheduleCheck(root) {
  const s = rootState(root);
  if (s.running) {
    s.dirty = true;
    return;
  }
  s.running = true;
  runCheck(root, (diagLines) => {
    publish(root, diagLines);
    s.running = false;
    if (s.dirty) {
      s.dirty = false;
      scheduleCheck(root);
    }
  });
}

function runCheck(root, done) {
  // Absolute root path: komp's crate dedup mis-canonicalizes relative paths
  // whose ".." escape the invocation directory.
  const child = spawn(KOMP_BIN, ['check', '--diagnostic-format=json', root], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const killer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => {
    clearTimeout(killer);
    log(`failed to run ${KOMP_BIN}: ${e.message}`);
    done([]);
  });
  child.on('close', () => {
    clearTimeout(killer);
    if (err.trim()) log(`komp stderr: ${err.trim().slice(0, 400)}`);
    const diags = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d && typeof d.message === 'string') diags.push(d);
      } catch {
        // Non-JSON compiler chatter (e.g. usage errors); surface it once.
        log(`komp: ${line.trim().slice(0, 400)}`);
      }
    }
    done(diags);
  });
}

// -------------------------------------------------------------- publishing

const SEVERITY = { error: 1, warning: 2, note: 3 };

function publish(root, diagLines) {
  const byFile = new Map();
  for (const d of diagLines) {
    if (!d.file) continue; // no span; nothing to attach it to
    const file = path.resolve(root, d.file);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(d);
  }

  const s = rootState(root);
  for (const stale of s.published) {
    if (!byFile.has(stale)) {
      notify('textDocument/publishDiagnostics', {
        uri: pathToFileURL(stale).href,
        diagnostics: [],
      });
    }
  }

  for (const [file, diags] of byFile) {
    const mapper = offsetMapper(file);
    notify('textDocument/publishDiagnostics', {
      uri: pathToFileURL(file).href,
      diagnostics: diags.map((d) => toLspDiagnostic(d, mapper, root)),
    });
    rememberFixes(file, diags, mapper, root);
  }
  for (const stale of s.published) if (!byFile.has(stale)) FIXES.delete(stale);
  s.published = new Set(byFile.keys());
}

// ------------------------------------------------------------ code actions

/// Fixes from the last check, per file. A diagnostic's repair is computed
/// once, when the crate is checked; a client asks for code actions far more
/// often than that, so the answer is kept rather than recomputed.
const FIXES = new Map();

function rememberFixes(file, diags, mapper, root) {
  const kept = [];
  for (const d of diags) {
    const fix = d.fix;
    if (!fix || !mapper) continue;
    if (!Number.isInteger(fix.byte_start) || !Number.isInteger(fix.byte_end)) continue;
    kept.push({
      title: fix.title || 'apply fix',
      newText: fix.replacement ?? '',
      // The repair may land in a different file from the diagnostic.
      file: fix.file ? path.resolve(path.dirname(file), fix.file) : file,
      range: { start: mapper(fix.byte_start), end: mapper(fix.byte_end) },
      diagnostic: toLspDiagnostic(d, mapper, root),
      // Offered where the PROBLEM is, which is not always where the repair
      // goes: an inserted import lands at the top of the file while the
      // unresolved name is far below it.
      at: toLspDiagnostic(d, mapper, root).range,
    });
  }
  if (kept.length) FIXES.set(file, kept);
  else FIXES.delete(file);
}

function codeActionsFor(file, range) {
  const kept = FIXES.get(file);
  if (!kept) return [];
  return kept
    .filter((f) => overlaps(f.at, range))
    .map((f) => ({
      title: f.title,
      kind: 'quickfix',
      diagnostics: [f.diagnostic],
      edit: {
        changes: {
          [pathToFileURL(f.file).href]: [{ range: f.range, newText: f.newText }],
        },
      },
    }));
}

/// Whether a fix is worth offering for the range a client asked about.
///
/// Compared by LINE, deliberately. A client asks with whatever it has —
/// the cursor as an empty range, the selection, the whole line — and a
/// column-exact test rejects the most common of those: an empty range at
/// column 0 is "before" a fix at column 13 on the same line, which is not
/// what a reader with their cursor on that line means.
///
/// The range compared is the DIAGNOSTIC's, not the repair's.
function overlaps(a, b) {
  if (!b) return true;
  return a.end.line >= b.start.line && a.start.line <= b.end.line;
}

function toLspDiagnostic(d, mapper, root) {
  let start;
  let end;
  if (mapper && Number.isInteger(d.byte_start) && Number.isInteger(d.byte_end)) {
    start = mapper(d.byte_start);
    end = mapper(Math.max(d.byte_end, d.byte_start + 1));
  } else {
    // Fall back to the compiler's 1-based line/column (byte columns; close
    // enough on the rare non-ASCII line when the file was unreadable).
    const line = Math.max(0, (d.line ?? 1) - 1);
    const col = Math.max(0, (d.column ?? 1) - 1);
    start = { line, character: col };
    end = { line, character: col + 1 };
  }
  const out = {
    range: { start, end },
    severity: SEVERITY[d.severity] ?? 1,
    source: 'komp',
    message: d.message,
  };
  // The lint that fired, when one did. An editor shows it beside the
  // message and filters on it; it is null for ordinary compiler errors,
  // which have no name to configure (schema_version 2).
  if (typeof d.code === 'string' && d.code) out.code = d.code;
  // The supporting labels, which the text renderer prints as `= note:`
  // lines (schema_version 3). An editor shows these underneath the message
  // as clickable jumps — the "first declared here" the note names.
  const related = toRelatedInformation(d, root);
  if (related) out.relatedInformation = related;
  return out;
}

/// A diagnostic's secondary labels as LSP related information.
///
/// Each label names its own file, because a note routinely points into a
/// different one from the error it supports, so each gets its own offset
/// mapper rather than reusing the diagnostic's. A label the compiler could
/// not place carries no file and is dropped: related information is a
/// jump target, and there is nowhere to jump to.
function toRelatedInformation(d, root) {
  if (!root || !Array.isArray(d.secondary) || d.secondary.length === 0) return undefined;
  const out = [];
  const mappers = new Map();
  for (const lbl of d.secondary) {
    if (!lbl || typeof lbl.message !== 'string' || !lbl.file) continue;
    const file = path.resolve(root, lbl.file);
    if (!mappers.has(file)) mappers.set(file, offsetMapper(file));
    const m = mappers.get(file);
    let start;
    let end;
    if (m && Number.isInteger(lbl.byte_start) && Number.isInteger(lbl.byte_end)) {
      start = m(lbl.byte_start);
      end = m(Math.max(lbl.byte_end, lbl.byte_start + 1));
    } else {
      const line = Math.max(0, (lbl.line ?? 1) - 1);
      const col = Math.max(0, (lbl.column ?? 1) - 1);
      start = { line, character: col };
      end = { line, character: col + 1 };
    }
    out.push({
      location: { uri: pathToFileURL(file).href, range: { start, end } },
      message: lbl.message,
    });
  }
  return out.length ? out : undefined;
}

/// komp names an item's role; LSP wants a number from its CompletionItemKind
/// enum. Member completion answers `field` and `method`; scope completion
/// answers the rest.
const COMPLETION_KIND = {
  field: 5,
  method: 2,
  local: 6, // Variable
  parameter: 6, // LSP has no Parameter kind; a parameter is a variable
  function: 3,
  struct: 22,
  enum: 13,
  trait: 8, // Interface
};

function toCompletionItem(item) {
  const out = { label: item.label };
  const kind = COMPLETION_KIND[item.kind];
  if (kind !== undefined) out.kind = kind;
  if (item.detail) out.detail = item.detail;
  return out;
}

/// komp answers a rename as a flat list of spans across files; LSP wants
/// them grouped by document URI. Each file's own byte-to-position mapping
/// is used, since an edit may land in a file the request was not about.
function toWorkspaceChanges(edits, newText) {
  const changes = {};
  const mappers = new Map();
  for (const e of edits) {
    if (!mappers.has(e.file)) mappers.set(e.file, offsetMapper(e.file));
    const mapper = mappers.get(e.file);
    if (!mapper) continue;
    const uri = pathToFileURL(e.file).href;
    (changes[uri] ??= []).push({
      range: { start: mapper(e.byte_start), end: mapper(e.byte_end) },
      newText,
    });
  }
  return changes;
}

// ----------------------------------------------------------------- queries

// `komp query` reads the file from disk, so every answer describes the last
// saved state — the same freshness the diagnostics have. A typed query also
// needs the file to sit inside its crate, which rules out staging an unsaved
// buffer through a temporary copy.
const TYPED_QUERIES = new Set(['hover', 'inlays', 'signature', 'references', 'tokens', 'completion', 'rename']);
function runQuery(what, filePath, extraArgs, done) {
  const child = spawn(KOMP_BIN, ['query', what, '--file', filePath].concat(extraArgs), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const bound = TYPED_QUERIES.has(what) ? TYPED_QUERY_TIMEOUT_MS : QUERY_TIMEOUT_MS;
  const killer = setTimeout(() => child.kill('SIGKILL'), bound);
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', () => {});
  child.on('error', (e) => {
    clearTimeout(killer);
    log(`failed to run ${KOMP_BIN}: ${e.message}`);
    done(null);
  });
  child.on('close', () => {
    clearTimeout(killer);
    let answer = null;
    try {
      answer = JSON.parse(out.trim().split('\n').pop() || 'null');
    } catch {
      log(`komp query ${what}: unparseable answer`);
    }
    if (answer && answer.severity === 'error') {
      log(`komp query ${what}: ${answer.message}`);
      answer = null;
    }
    done(answer);
  });
}

// komp names kinds in KFlat's vocabulary; the protocol's numbers live here.
const SYMBOL_KIND = {
  function: 12,
  method: 6,
  extern: 12,
  struct: 23,
  enum: 10,
  variant: 22,
  field: 8,
  trait: 11,
  impl: 19,
  type: 26,
};

function toLspSymbol(symbol, mapper) {
  const range = {
    start: mapper(symbol.byte_start),
    end: mapper(symbol.byte_end),
  };
  return {
    name: symbol.name || '<anonymous>',
    detail: symbol.detail || undefined,
    kind: SYMBOL_KIND[symbol.kind] ?? 19,
    range,
    // komp does not record where a declaration's name token is, so the
    // whole declaration stands in for it. The protocol only requires that
    // the selection range be inside the range.
    selectionRange: range,
    children: (symbol.children ?? []).map((child) => toLspSymbol(child, mapper)),
  };
}

function toLspFoldingRanges(ranges, mapper) {
  const out = [];
  for (const r of ranges) {
    const start = mapper(r.byte_start).line;
    const end = mapper(r.byte_end).line;
    // Nothing to collapse on one line, and komp leaves the filtering here
    // because it is this side that knows where the lines are.
    if (end <= start) continue;
    out.push({ startLine: start, endLine: end, kind: r.kind === 'imports' ? 'imports' : 'region' });
  }
  return out;
}

/// A SelectionRange is a linked list: each step points at the one that
/// encloses it. komp answers innermost first, so the chain is built from
/// the far end backwards.
function toLspSelectionRange(ranges, mapper) {
  let parent;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    parent = { range: { start: mapper(r.byte_start), end: mapper(r.byte_end) }, parent };
  }
  return parent ?? null;
}

// komp names a role; the protocol wants an index into this list, and the
// client is told the list at initialize.
/// Hover contents: what the cursor names, then what it is documented as.
///
/// The signature is preferred over the expression's type when both are
/// there — it already contains the return type, and `add(a: int32, b:
/// int32): int32` tells the reader more than `int32` does. The type is the
/// answer for everything that has no declaration: a literal, an operator
/// result, a field read.
function hoverMarkdown(answer) {
  const parts = [];
  const code = typeof answer.signature === 'string' ? answer.signature
             : typeof answer.type === 'string' ? answer.type
             : null;
  if (code) parts.push('```kflat\n' + code + '\n```');
  if (typeof answer.documentation === 'string' && answer.documentation !== '') {
    if (parts.length) parts.push('---');
    parts.push(answer.documentation);
  }
  return parts.join('\n');
}

const SEMANTIC_LEGEND = {
  tokenTypes: ['variable', 'function', 'method', 'property', 'type'],
  tokenModifiers: [],
};
const SEMANTIC_INDEX = {
  variable: 0,
  function: 1,
  method: 2,
  field: 3,
  type: 4,
};

/// The protocol's five-integer-per-token encoding, each token relative to
/// the one before it: line delta, start delta (restarting each line),
/// length, type, modifiers.
///
/// A token spanning more than one line has no representation here, so it
/// is dropped rather than mis-encoded — the rest of the line would shift.
function encodeSemanticTokens(tokens, mapper) {
  const data = [];
  let lastLine = 0;
  let lastStart = 0;
  for (const t of tokens) {
    const start = mapper(t.byte_start);
    const end = mapper(t.byte_end);
    if (end.line !== start.line) continue;
    const type = SEMANTIC_INDEX[t.type];
    if (type === undefined) continue;
    const deltaLine = start.line - lastLine;
    const deltaStart = deltaLine === 0 ? start.character - lastStart : start.character;
    data.push(deltaLine, deltaStart, end.character - start.character, type, 0);
    lastLine = start.line;
    lastStart = start.character;
  }
  return data;
}

/// One span from a query into an LSP Location. Each carries its own file,
/// so the mapper is per-entry rather than per-request.
function toLspLocation(entry) {
  const mapper = offsetMapper(entry.file);
  const range = mapper
    ? { start: mapper(entry.byte_start), end: mapper(entry.byte_end) }
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return { uri: pathToFileURL(entry.file).href, range };
}

function toLspInlayHints(hints, range, mapper) {
  const out = [];
  for (const h of hints) {
    const at = mapper(h.byte_offset);
    if (range && !positionInRange(at, range)) continue;
    out.push({ position: at, label: h.label, kind: 1, paddingLeft: false });
  }
  return out;
}

function positionInRange(at, range) {
  if (at.line < range.start.line || at.line > range.end.line) return false;
  if (at.line === range.start.line && at.character < range.start.character) return false;
  if (at.line === range.end.line && at.character > range.end.character) return false;
  return true;
}

/// LSP Position -> byte offset, the inverse of offsetMapper. Reads the file
/// from disk, as every query does.
function byteOffsetOf(file, position) {
  let content;
  try {
    content = fs.readFileSync(file);
  } catch {
    return null;
  }
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0a) lineStarts.push(i + 1);
  }
  const line = Math.min(Math.max(position.line, 0), lineStarts.length - 1);
  const lineStart = lineStarts[line];
  const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] : content.length;
  if (positionEncoding === 'utf-8') {
    return Math.min(lineStart + position.character, lineEnd);
  }
  // UTF-16 code units in, bytes out: walk the line until that many units
  // have been consumed.
  const text = content.subarray(lineStart, lineEnd).toString('utf8');
  const prefix = text.slice(0, position.character);
  return lineStart + Buffer.byteLength(prefix, 'utf8');
}

// Byte offset -> LSP Position for one file, honoring the negotiated encoding.
function offsetMapper(file) {
  let content;
  try {
    content = fs.readFileSync(file);
  } catch {
    return null;
  }
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0a) lineStarts.push(i + 1);
  }
  return (offset) => {
    offset = Math.min(Math.max(offset, 0), content.length);
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const character =
      positionEncoding === 'utf-8'
        ? offset - lineStarts[lo]
        : content.subarray(lineStarts[lo], offset).toString('utf8').length;
    return { line: lo, character };
  };
}
