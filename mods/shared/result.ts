import type { ToolCallResult } from 'claude-code';
import type { Envelope } from '../../core/src/errors';

export function toolResult(envelope: Envelope): ToolCallResult {
  const result = JSON.stringify(envelope);
  return envelope.ok ? { result } : { result, isError: true };
}
