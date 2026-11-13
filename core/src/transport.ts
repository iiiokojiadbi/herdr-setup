export interface RunOptions { cwd: string; timeoutMs: number }
export interface RunResult { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
export interface Transport { run(argv: string[], options: RunOptions): Promise<RunResult> }
