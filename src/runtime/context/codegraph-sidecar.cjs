'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const SCHEMA_VERSION = 1;
const ALLOWED_OPERATIONS = new Set(['status', 'search', 'context', 'impact', 'file_dependencies']);

function clamp(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function fail(operation, code, message) {
  process.stdout.write(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    operation,
    error: { code, message: String(message).slice(0, 1000) },
  }));
  process.exitCode = 1;
}

function nodeSummary(node) {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    ...(node.signature ? { signature: String(node.signature).slice(0, 1000) } : {}),
  };
}

function edgeSummary(edge) {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    ...(typeof edge.line === 'number' ? { line: edge.line } : {}),
    ...(edge.provenance ? { provenance: edge.provenance } : {}),
  };
}

function subgraphSummary(subgraph, maxNodes) {
  const nodes = Array.from(subgraph.nodes.values()).slice(0, maxNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = subgraph.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .slice(0, maxNodes * 3);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    nodes: nodes.map(nodeSummary),
    edges: edges.map(edgeSummary),
    roots: subgraph.roots.filter((id) => nodeIds.has(id)).slice(0, 20),
    entryPoints: subgraph.roots.map((id) => byId.get(id)).filter(Boolean).slice(0, 12).map(nodeSummary),
    relatedFiles: Array.from(new Set(nodes.map((node) => node.filePath).filter(Boolean))).slice(0, 80),
    ...(subgraph.confidence ? { confidence: subgraph.confidence } : {}),
    truncated: subgraph.nodes.size > nodes.length || subgraph.edges.length > edges.length,
  };
}

function metadata(graph) {
  const changed = graph.getChangedFiles();
  const build = graph.getIndexBuildInfo();
  const stats = graph.getStats();
  return {
    initialized: true,
    lastIndexedAt: graph.getLastIndexedAt(),
    buildVersion: build.version,
    extractionVersion: build.extractionVersion,
    staleEngine: graph.isIndexStale(),
    changedFiles: {
      added: changed.added.slice(0, 50),
      modified: changed.modified.slice(0, 50),
      removed: changed.removed.slice(0, 50),
    },
    stats: {
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      fileCount: stats.fileCount,
      dbSizeBytes: stats.dbSizeBytes,
      lastUpdated: stats.lastUpdated,
    },
    backend: String(graph.getBackend()),
    journalMode: String(graph.getJournalMode()),
  };
}

async function main() {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (error) {
    fail(undefined, 'CODEGRAPH_REQUEST_INVALID', error instanceof Error ? error.message : error);
    return;
  }
  const operation = request && request.operation;
  if (!request || request.schemaVersion !== SCHEMA_VERSION || !ALLOWED_OPERATIONS.has(operation)) {
    fail(operation, 'CODEGRAPH_OPERATION_NOT_ALLOWED', `Unsupported read operation: ${String(operation)}`);
    return;
  }
  if (typeof request.projectRoot !== 'string' || !path.isAbsolute(request.projectRoot)) {
    fail(operation, 'CODEGRAPH_PROJECT_ROOT_INVALID', 'projectRoot must be an absolute path selected by Forge.');
    return;
  }

  let library;
  try {
    const configuredLibrary = process.env.FORGE_CODEGRAPH_LIBRARY_PATH;
    library = require(configuredLibrary || '@colbymchenry/codegraph');
    if (typeof library.setLogger === 'function' && library.silentLogger) library.setLogger(library.silentLogger);
  } catch (error) {
    fail(operation, 'CODEGRAPH_LIBRARY_UNAVAILABLE', error instanceof Error ? error.message : error);
    return;
  }
  const CodeGraph = library.CodeGraph || library.default;
  if (!CodeGraph || typeof CodeGraph.open !== 'function') {
    fail(operation, 'CODEGRAPH_LIBRARY_UNAVAILABLE', 'CodeGraph SDK entry point is unavailable.');
    return;
  }
  if (!CodeGraph.isInitialized(request.projectRoot)) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      operation,
      metadata: {
        initialized: false,
        lastIndexedAt: null,
        buildVersion: null,
        extractionVersion: null,
        staleEngine: false,
        changedFiles: { added: [], modified: [], removed: [] },
      },
      result: {},
      timingsMs: { open: 0, query: 0 },
    }));
    return;
  }

  let graph;
  const openStartedAt = performance.now();
  try {
    graph = await CodeGraph.open(request.projectRoot, { sync: false, readOnly: true });
  } catch (error) {
    fail(operation, 'CODEGRAPH_OPEN_FAILED', error instanceof Error ? error.message : error);
    return;
  }
  const openMs = Math.round((performance.now() - openStartedAt) * 100) / 100;

  try {
    const queryStartedAt = performance.now();
    const limit = clamp(request.limit, 12, 1, 40);
    const maxNodes = clamp(request.maxNodes, 40, 1, 80);
    const maxDepth = clamp(request.maxDepth, 2, 1, 5);
    let result = {};
    if (operation === 'search') {
      if (typeof request.query !== 'string' || !request.query.trim()) throw new Error('CODEGRAPH_QUERY_REQUIRED');
      result = {
        results: graph.searchNodes(request.query.trim(), { limit }).map((entry) => ({
          node: nodeSummary(entry.node),
          score: entry.score,
          highlights: Array.isArray(entry.highlights) ? entry.highlights.slice(0, 8).map((value) => String(value).slice(0, 500)) : [],
        })),
      };
    } else if (operation === 'context') {
      if (typeof request.query !== 'string' || !request.query.trim()) throw new Error('CODEGRAPH_QUERY_REQUIRED');
      const subgraph = await graph.findRelevantContext(request.query.trim(), {
        searchLimit: Math.min(limit, 12),
        traversalDepth: Math.min(maxDepth, 3),
        maxNodes,
      });
      result = subgraphSummary(subgraph, maxNodes);
    } else if (operation === 'impact') {
      if (typeof request.nodeId !== 'string' || !request.nodeId.trim()) throw new Error('CODEGRAPH_NODE_ID_REQUIRED');
      result = subgraphSummary(graph.getImpactRadius(request.nodeId.trim(), maxDepth), maxNodes);
    } else if (operation === 'file_dependencies') {
      if (typeof request.filePath !== 'string' || !request.filePath.trim()) throw new Error('CODEGRAPH_FILE_PATH_REQUIRED');
      result = {
        filePath: request.filePath.trim(),
        dependencies: graph.getFileDependencies(request.filePath.trim()).slice(0, 100),
        dependents: graph.getFileDependents(request.filePath.trim()).slice(0, 100),
      };
    } else if (operation === 'status') {
      result = {};
    }
    const queryMs = Math.round((performance.now() - queryStartedAt) * 100) / 100;
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      operation,
      metadata: metadata(graph),
      result,
      timingsMs: { open: openMs, query: queryMs },
    }));
  } catch (error) {
    fail(operation, 'CODEGRAPH_QUERY_FAILED', error instanceof Error ? error.message : error);
  } finally {
    try { graph.close(); } catch (_) { /* no-op */ }
  }
}

main().catch((error) => fail(undefined, 'CODEGRAPH_SIDECAR_UNHANDLED', error instanceof Error ? error.message : error));
