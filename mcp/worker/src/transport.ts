import { execFile } from 'node:child_process';
import type { Transport } from '../../../core/src/transport';
export const processTransport: Transport = {
  run: ([executable, ...args], {cwd, timeoutMs}) => new Promise((resolve, reject) => {
    execFile(executable, args, {cwd, timeout:timeoutMs, maxBuffer:65536, encoding:'utf8'}, (error, stdout, stderr) => {
      if (error && (error.code === 'ENOENT' || error.killed)) return reject(error.killed ? new Error('Process timeout') : error);
      resolve({exitCode:error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, isStdoutTruncated:error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', isStderrTruncated:error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
    });
  }),
};
