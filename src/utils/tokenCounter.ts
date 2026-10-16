import { encodingForModel } from 'js-tiktoken';

export function countTokens(text: string): number {
  const encoding = encodingForModel('gpt-4o');
  const tokens = encoding.encode(text);

  return tokens.length;
}

