import { FlowNode, FlowResult, allNodes, languageKindInfo } from '../core/types';

/**
 * Renders a domain `FlowResult` as markdown.
 *
 * The section layout is the historical VS Code contract (see `markdown.md`):
 * summary header + Root Method + Execution Dependencies + Related Data Models.
 * `warnings` (empty today on the Java path) renders as JetBrains-style quote
 * lines before the summary, so unresolved symbols surface when a future
 * extractor starts producing them.
 *
 * `raw` mode keeps the historical behaviour: the plain output shipped before
 * the migration (the command copies `maxDepth=0` material with the same
 * headers, so consumers never receive a bare snippet).
 */
export function formatFlow(result: FlowResult, mode: 'markdown' | 'raw' = 'markdown'): string {
  const nodes = allNodes(result);
  const models = result.models;

  if (nodes.length === 0) {
    return 'No flow extracted.';
  }

  const totalChars =
    nodes.reduce((acc, n) => acc + n.code.length, 0) +
    models.reduce((acc, m) => acc + m.code.length, 0);
  const estimatedTokens = Math.round(totalChars / 4);

  let output = `# Context Flow Extracted by Bisotun\n`;
  output += `- Root Target: \`${methodId(nodes[0])}\`\n`;
  output += `- Extracted Nodes: ${nodes.length}\n`;
  output += `- Extracted Models: ${models.length}\n`;
  output += `- Estimated Tokens: ~${estimatedTokens}\n\n`;

  for (const warning of result.warnings) {
    output += `> ${warning}\n`;
  }
  if (result.warnings.length > 0) output += '\n';

  // Root Method
  output += `## Root Method\n`;
  output += `### \`${methodId(nodes[0])}\`\n`;
  output += nodeDetail(nodes[0]);

  // Dependencies
  if (nodes.length > 1) {
    output += `## Execution Dependencies\n`;
    for (let i = 1; i < nodes.length; i++) {
      output += `### \`${methodId(nodes[i])}\`\n`;
      output += nodeDetail(nodes[i]);
    }
  }

  // Related Models / DTOs
  for (const model of models) {
    output += `## Related Data Models (DTOs / Projections / Records)\n`;
    output += `### Model: \`${model.displayName}\`\n`;
    output += `- File: \`${model.filePath}\`\n\n`;
    output += `\`\`\`${codeFence(model)}\n${model.code}\n\`\`\`\n\n`;
  }

  return output;
}

/** `Class.method(params)` domain displayName -> historic `Class#method` header form. */
function methodId(node: FlowNode): string {
  return node.displayName.replace(/\(.*\)$/, '').replace('.', '#');
}

function codeFence(node: FlowNode): string {
  return languageKindInfo(node.languageKind).codeFence;
}

function nodeDetail(node: FlowNode): string {
  return (
    `- File: \`${node.filePath}\`\n` +
    `- Lines: ${node.range.startLine}-${node.range.endLine}\n\n` +
    `\`\`\`${codeFence(node)}\n${node.code}\n\`\`\`\n\n`
  );
}
