import { Fault, codes, type Code, type Data, type Effect } from './errors';
import type { RunResult } from './transport';
export function parse(result: RunResult, effect: Effect = 'none'): Data {
  if (result.exitCode !== 0) {
    let details: any = result.stderr;
    try { details = JSON.parse(result.stderr); } catch {}
    const kind = details?.error?.kind?.toUpperCase();
    const code: Code = codes.includes(kind) ? kind : 'HC_ERROR';
    throw new Fault(code, 'hc command failed.', { stderr: details, isStderrTruncated: result.isStderrTruncated }, effect);
  }
  if (result.isStdoutTruncated) throw new Fault('INVALID_RESPONSE','hc JSON output was truncated.', undefined, effect);
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Fault('INVALID_RESPONSE','hc returned invalid JSON.', { stderr: result.stderr }, effect); }
}
export function terminal(value: Data): Data {
  if (typeof value.address !== 'string' || !value.address || typeof value.state !== 'string') throw new Fault('INVALID_RESPONSE','Terminal address or state missing.');
  return { address: value.address, name: value.name ?? null, template: value.template ?? null, parent: value.parent ?? null, state: value.state, status: typeof value.status === 'string' ? value.status : value.status?.state ?? null, cwd: value.cwd ?? null, turn: value.turn ?? null };
}
export function firstMessage(value: Data): Data | undefined {
  const message = value.first_message;
  if (message === undefined) return undefined;
  if (!message || typeof message.sent !== 'boolean') throw new Fault('INVALID_RESPONSE','Invalid first_message.');
  return message;
}
