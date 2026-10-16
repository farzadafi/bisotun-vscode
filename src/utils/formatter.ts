import { FlowResult } from '../core/flowCrawler';

export function formatFlow(result: FlowResult, mode: 'markdown' | 'raw' = 'markdown'): string {
  const { nodes, models } = result;

  if (nodes.length === 0) {
    return 'No flow extracted.';
  }

  const rootNode = nodes[0];
  const totalChars =
    nodes.reduce((acc, n) => acc + n.code.length, 0) +
    models.reduce((acc, m) => acc + m.code.length, 0);
  const estimatedTokens = Math.round(totalChars / 4);

  let output = `# Context Flow Extracted by Bisotun\n`;
  output += `- Root Target: \`${rootNode.className}#${rootNode.methodName}\`\n`;
  output += `- Extracted Nodes: ${nodes.length}\n`;
  output += `- Extracted Models: ${models.length}\n`;
  output += `- Estimated Tokens: ~${estimatedTokens}\n\n`;

  // Root Method
  output += `## Root Method\n`;
  output += `### \`${rootNode.className}#${rootNode.methodName}\`\n`;
  output += `- File: \`${rootNode.filePath}\`\n`;
  output += `- Lines: ${rootNode.startLine}-${rootNode.endLine}\n\n`;
  output += `\`\`\`${rootNode.language}\n${rootNode.code}\n\`\`\`\n\n`;

  // Dependencies
  if (nodes.length > 1) {
    output += `## Execution Dependencies\n`;
    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i];
      output += `### \`${node.className}#${node.methodName}\`\n`;
      output += `- File: \`${node.filePath}\`\n`;
      output += `- Lines: ${node.startLine}-${node.endLine}\n\n`;
      output += `\`\`\`${node.language}\n${node.code}\n\`\`\`\n\n`;
    }
  }

  // Related Models / DTOs
  if (models.length > 0) {
    output += `## Related Data Models (DTOs / Projections / Records)\n`;
    for (const model of models) {
      output += `### Model: \`${model.name}\`\n`;
      output += `- File: \`${model.filePath}\`\n\n`;
      output += `\`\`\`${rootNode.language}\n${model.code}\n\`\`\`\n\n`;
    }
  }

  return output;
}
