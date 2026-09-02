/**
 * Legacy Controller MCP compatibility facade.
 *
 * Gateway code imports the stable tool schema and result types from this
 * module, while the compatibility implementation itself is isolated in
 * legacy-tool-service.ts and is invoked for long work only by Worker
 * processes through the durable ExecutionJob pipeline.
 */
export * from './legacy-tool-service';
